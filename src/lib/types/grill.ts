import type { LineRange } from "./section";

export interface GrillQuestion {
	schema_version?: 1;
	question_id: string;
	title: string;
	question: string;
	pr_choice: string;
	recommended_answer: string;
	file_path?: string;
	line?: number;
	files?: string[];
	ranges?: LineRange[];
	base_ref?: string;
	head_ref?: string;
	answer_summary?: string;
	agrees_with_pr?: boolean;
	comment_draft_ids?: string[];
}
