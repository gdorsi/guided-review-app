import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { SeverityBadge } from "./SeverityBadge";
import { cn } from "@/lib/utils";
import type { Concern } from "@/lib/types/section";

export function formatConcernForCopy(concern: Concern): string {
	const text = concern.text.trim();
	if (!concern.file_path) return text;
	const location = concern.line
		? `${concern.file_path}:${concern.line}`
		: concern.file_path;
	return text ? `${text}\n${location}` : location;
}

export function ConcernItem({
	concern,
	onOpenLocation,
	marked = false,
	onToggleMarked,
}: {
	concern: Concern;
	onOpenLocation: (concern: Concern) => void;
	marked?: boolean;
	onToggleMarked?: (concern: Concern) => void;
}) {
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current !== null) {
				window.clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	const copy = useCallback(async () => {
		const payload = formatConcernForCopy(concern);
		try {
			await navigator.clipboard.writeText(payload);
			setCopied(true);
			if (copyTimeoutRef.current !== null) {
				window.clearTimeout(copyTimeoutRef.current);
			}
			copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Browser/WebView refused clipboard write; fall through silently.
		}
	}, [concern]);

	const hasLocation = Boolean(concern.file_path);
	const locationLabel = concern.file_path
		? concern.line
			? `${concern.file_path}:${concern.line}`
			: concern.file_path
		: null;

	return (
		<li className="group space-y-1 text-xs">
			<div className="flex items-center justify-between gap-2">
				<SeverityBadge severity={concern.severity} />
				<div className="flex items-center gap-1">
					{onToggleMarked && (
						<button
							type="button"
							onClick={() => onToggleMarked(concern)}
							aria-pressed={marked}
							className={cn(
								"inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus:outline-hidden focus-visible:ring-1 focus-visible:ring-primary",
								marked
									? "bg-primary/15 text-primary"
									: "border border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
							title={marked ? "Remove from review" : "Add to review"}
						>
							{marked ? (
								<Check className="size-3" />
							) : (
								<Plus className="size-3" />
							)}
							{marked ? "In review" : "Add to review"}
						</button>
					)}
				<button
					type="button"
					onClick={copy}
					className={cn(
						"inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted/60 hover:text-foreground focus:outline-hidden focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary",
						copied
							? "opacity-100"
							: "opacity-0 group-hover:opacity-100",
					)}
					aria-label={copied ? "Copied" : "Copy concern"}
					title={copied ? "Copied" : "Copy concern"}
				>
					{copied ? (
						<Check className="size-3 text-primary" />
					) : (
						<Copy className="size-3" />
					)}
				</button>
				</div>
			</div>
			<div>{concern.text}</div>
			{locationLabel && (
				hasLocation && concern.line ? (
					<button
						type="button"
						onClick={() => onOpenLocation(concern)}
						className="block max-w-full truncate font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus:outline-hidden focus-visible:text-foreground focus-visible:underline"
						title="Open this line in the diff"
					>
						{locationLabel}
					</button>
				) : (
					<div className="font-mono text-[10px] text-muted-foreground">
						{locationLabel}
					</div>
				)
			)}
		</li>
	);
}

export function FeedbackList({
	title,
	concerns,
	onOpenLocation,
	isMarked,
	onToggleMarked,
}: {
	title: string;
	concerns: Concern[];
	onOpenLocation: (concern: Concern) => void;
	isMarked?: (concern: Concern) => boolean;
	onToggleMarked?: (concern: Concern) => void;
}) {
	if (concerns.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</div>
			<ul className="space-y-1.5">
				{concerns.map((concern, index) => (
					<ConcernItem
						key={index}
						concern={concern}
						onOpenLocation={onOpenLocation}
						marked={isMarked?.(concern) ?? false}
						onToggleMarked={onToggleMarked}
					/>
				))}
			</ul>
		</div>
	);
}
