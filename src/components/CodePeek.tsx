import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { selectPeekLines, type PeekLine } from "@/lib/codePeek";
import { cn } from "@/lib/utils";
import type { CommentDraft } from "@/lib/types/section";

const peekCache = new Map<string, string>();

export function CodePeek({ comment }: { comment: CommentDraft }) {
	const session = useApp((s) => s.session);
	const [lines, setLines] = useState<PeekLine[] | null>(null);
	const [error, setError] = useState(false);

	const filePath = comment.file_path;
	const line = comment.line;
	const refspec =
		comment.side === "LEFT" ? session?.repo.base_ref : session?.repo.head_ref;
	const repoPath = session?.repo.path;

	useEffect(() => {
		if (!repoPath || !filePath || !line || !refspec) return;
		let cancelled = false;
		const key = `${repoPath}::${filePath}::${refspec}`;
		(async () => {
			try {
				let content = peekCache.get(key);
				if (content === undefined) {
					const fetched = await acp.getFileAtRef({
						repo_path: repoPath,
						file_path: filePath,
						refspec,
					});
					content = fetched ?? "";
					peekCache.set(key, content);
				}
				if (!cancelled) setLines(selectPeekLines(content, line));
			} catch {
				if (!cancelled) setError(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [repoPath, filePath, line, refspec]);

	if (!filePath || !line) return null;
	if (error) {
		return (
			<div className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
				code unavailable
			</div>
		);
	}
	if (!lines) {
		return (
			<div className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
				loading…
			</div>
		);
	}
	return (
		<pre className="overflow-x-auto bg-background/60 py-1.5 font-mono text-[11px] leading-relaxed">
			{lines.map((l) => (
				<div
					key={l.number}
					className={cn(
						"px-3",
						l.isTarget && "bg-primary/15 border-l-2 border-primary",
					)}
				>
					<span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">
						{l.number}
					</span>
					<span className="text-foreground/90">{l.text || " "}</span>
				</div>
			))}
		</pre>
	);
}
