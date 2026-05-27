import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const requiredReleaseEnv = [
	"APPLE_ID",
	"APPLE_PASSWORD",
	"APPLE_TEAM_ID",
];

const certificateReleaseEnv = [
	"APPLE_CERTIFICATE",
	"APPLE_CERTIFICATE_PASSWORD",
];

function unquote(value) {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function stripInlineComment(value) {
	let quote = null;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
			quote = quote === char ? null : quote || char;
			continue;
		}
		if (!quote && char === "#" && /\s/.test(value[i - 1] ?? "")) {
			return value.slice(0, i);
		}
	}
	return value;
}

export function parseDotEnv(content) {
	const env = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const separator = line.indexOf("=");
		if (separator === -1) continue;

		const key = line.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

		const value = line.slice(separator + 1);
		env[key] = unquote(stripInlineComment(value));
	}
	return env;
}

export function mergeReleaseEnv(processEnv, fileEnv) {
	return {
		...processEnv,
		...Object.fromEntries(
			Object.entries(fileEnv).filter(([key]) => !processEnv[key]),
		),
	};
}

export function missingReleaseEnv(env) {
	const missing = requiredReleaseEnv.filter((key) => !env[key]);
	if (!env.APPLE_SIGNING_IDENTITY) {
		missing.push(...certificateReleaseEnv.filter((key) => !env[key]));
	}
	return missing;
}

export function releaseBuildEnv(env) {
	const next = { ...env };
	if (next.APPLE_SIGNING_IDENTITY) {
		delete next.APPLE_CERTIFICATE;
		delete next.APPLE_CERTIFICATE_PASSWORD;
	}
	return next;
}

export function parseCliArgs(args) {
	if (args[0] && !args[0].startsWith("-")) {
		return {
			envPath: args[0],
			extraArgs: args.slice(1),
		};
	}
	return {
		envPath: ".env",
		extraArgs: args,
	};
}

export function buildReleaseCommandArgs(extraArgs) {
	return [
		"run",
		"tauri",
		"--",
		"build",
		"--target",
		"universal-apple-darwin",
		...extraArgs,
	];
}

function releaseFlag(value) {
	return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

export function releaseMetadata(env, version) {
	return {
		tag: env.RELEASE_TAG || `guided-review-v${version}`,
		title: env.RELEASE_NAME || `Guided Review v${version}`,
		notes:
			env.RELEASE_NOTES ||
			"Signed and notarized macOS build. Download the app from the assets below.",
		draft: releaseFlag(env.RELEASE_DRAFT),
		prerelease: releaseFlag(env.RELEASE_PRERELEASE),
		repo: env.GH_REPO || env.GITHUB_REPOSITORY || undefined,
	};
}

async function walkFiles(root) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) return walkFiles(fullPath);
			return [fullPath];
		}),
	);
	return files.flat();
}

export async function findReleaseAssets(bundleDir) {
	const files = await walkFiles(bundleDir);
	return files
		.filter(
			(file) =>
				file.endsWith(".dmg") ||
				file.endsWith(".app.tar.gz") ||
				file.endsWith(".app.tar.gz.sig"),
		)
		.sort();
}

function appendReleaseOptions(args, metadata) {
	if (metadata.draft) args.push("--draft");
	if (metadata.prerelease) args.push("--prerelease");
	if (metadata.repo) args.push("--repo", metadata.repo);
	return args;
}

export function buildGhReleaseCreateArgs(metadata, assets) {
	return appendReleaseOptions(
		[
			"release",
			"create",
			metadata.tag,
			...assets,
			"--title",
			metadata.title,
			"--notes",
			metadata.notes,
		],
		metadata,
	);
}

export function buildGhReleaseViewArgs(metadata) {
	const args = ["release", "view", metadata.tag];
	if (metadata.repo) args.push("--repo", metadata.repo);
	return args;
}

export function buildGhAuthStatusArgs() {
	return ["auth", "status"];
}

async function loadDotEnv(path) {
	try {
		return parseDotEnv(await fs.readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error(`Missing ${path}. Create it with the Apple release vars first.`);
		}
		throw error;
	}
}

function run(command, args, env, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: options.stdio ?? "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} exited with status ${code}`));
			}
		});
	});
}

async function readAppVersion() {
	const pkg = JSON.parse(
		await fs.readFile("package.json", "utf8"),
	);
	if (!pkg.version) {
		throw new Error("src-tauri/tauri.conf.json is missing a version field.");
  }
	return pkg.version;
}

async function commandSucceeds(command, args, env) {
	try {
		await run(command, args, env, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function ensureReleaseTagAvailable(metadata, env) {
	if (await commandSucceeds("gh", buildGhReleaseViewArgs(metadata), env)) {
		throw new Error(
			`Release tag ${metadata.tag} already exists on GitHub. Set RELEASE_TAG to a different value or delete the existing release before retrying.`,
		);
	}
}

async function publishRelease(metadata, assets, env) {
	console.log(`Creating GitHub release ${metadata.tag}.`);
	await run("gh", buildGhReleaseCreateArgs(metadata, assets), env);
}

async function main() {
	const { envPath, extraArgs } = parseCliArgs(process.argv.slice(2));
	const fileEnv = await loadDotEnv(envPath);
	const env = mergeReleaseEnv(process.env, fileEnv);
	const missing = missingReleaseEnv(env);

	if (missing.length > 0) {
		throw new Error(`Missing release env vars: ${missing.join(", ")}`);
	}

	console.log(`Loaded release environment from ${envPath}`);
	console.log("Checking GitHub CLI authentication.");
	await run("gh", buildGhAuthStatusArgs(), env);

	const version = await readAppVersion();
	const metadata = releaseMetadata(env, version);
	console.log(`Verifying release tag ${metadata.tag} is available.`);
	await ensureReleaseTagAvailable(metadata, env);

	const args = buildReleaseCommandArgs(extraArgs);
	console.log(`Running: npm ${args.join(" ")}`);
	const buildEnv = releaseBuildEnv(env);
	await run("npm", args, buildEnv);

	const bundleDir = path.join(
		"src-tauri",
		"target",
		"universal-apple-darwin",
		"release",
		"bundle",
	);
	const assets = await findReleaseAssets(bundleDir);
	if (assets.length === 0) {
		throw new Error(`No release assets found in ${bundleDir}`);
	}

	console.log(`Found release assets:\n${assets.map((asset) => `- ${asset}`).join("\n")}`);
	await publishRelease(metadata, assets, env);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
