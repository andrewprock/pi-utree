/**
 * /utree - conversation view with the same UX as the built-in /tree
 *
 * Reuses pi's own TreeSelectorComponent (the exact /tree UI: arrow navigation,
 * search-as-you-type, fold/unfold, ctrl+x copy, filters) but feeds it a pruned
 * tree that shows a clean conversation:
 *
 *   user:
 *   assistant:   <- only the LAST assistant response of each turn
 *   user:
 *   assistant:
 *   ...
 *
 * Thinking blocks, tool calls, and tool results are excluded, and chains of
 * assistant messages within one turn (progress updates between tool calls)
 * are collapsed to the final response.
 *
 * Enter navigates the session to the selected point, mirroring /tree
 * (including the "Summarize branch?" prompt).
 *
 * In print/JSON mode it writes a plain transcript to stdout instead.
 */

import {
	TreeSelectorComponent,
	type ExtensionAPI,
	type SessionEntry,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

function roleOf(entry: SessionEntry): "user" | "assistant" | undefined {
	if (entry.type !== "message") return undefined;
	const message = (entry as { message?: { role?: string } }).message;
	return message?.role as "user" | "assistant" | undefined;
}

function hasText(entry: SessionEntry): boolean {
	const message = (entry as { message?: { content?: unknown } }).message;
	return textOf(message?.content).trim().length > 0;
}

/** Base filter: only user statements and assistant text responses. */
function keepEntry(entry: SessionEntry): boolean {
	const role = roleOf(entry);
	return (role === "user" || role === "assistant") && hasText(entry);
}

function isAssistantNode(node: SessionTreeNode): boolean {
	return roleOf(node.entry) === "assistant";
}

/** Kept descendants of a node, re-attached to the nearest kept ancestor. */
function keptChildren(node: SessionTreeNode): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const child of node.children) {
		if (keepEntry(child.entry)) {
			out.push({ ...child, children: keptChildren(child) });
		} else {
			out.push(...keptChildren(child));
		}
	}
	return out;
}

/**
 * Collapse assistant chains: drop an assistant node that continues into
 * another assistant response (intermediate "working on it..." messages
 * around tool calls) as long as it is not itself the direct final response
 * of some branch (no direct user child).
 */
function collapseChains(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const node of nodes) {
		const children = collapseChains(node.children);
		if (isAssistantNode(node) && children.some(isAssistantNode) && !children.some(isUserNode)) {
			// Intermediate response: drop it, hoist its children to its parent.
			out.push(...children);
		} else {
			out.push({ ...node, children });
		}
	}
	return out;
}

function isUserNode(node: SessionTreeNode): boolean {
	return roleOf(node.entry) === "user";
}

function pruneTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (keepEntry(node.entry)) {
			out.push({ ...node, children: collapseChains(keptChildren(node)) });
		} else {
			out.push(...collapseChains(keptChildren(node)));
		}
	}
	return out;
}

/** Last conversation entry on the current branch (for initial selection). */
function nearestKeptId(sessionManager: { getBranch(): SessionEntry[] }): string | null {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		if (keepEntry(branch[i])) return branch[i].id;
	}
	return null;
}

/** Flat transcript for non-TUI modes, with the same chain collapsing. */
function plainTranscript(sessionManager: { getBranch(): SessionEntry[] }): string {
	const kept = sessionManager.getBranch().filter(keepEntry);
	const lines: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		const entry = kept[i];
		const message = (entry as { message: { role: string; content?: unknown; model?: string } }).message;
		// Skip assistant responses that are followed by another assistant
		// response before the next user statement.
		if (message.role === "assistant") {
			const next = kept[i + 1];
			if (next && roleOf(next) === "assistant") continue;
		}
		const time = entry.timestamp
			? new Date(entry.timestamp as string | number).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
			: "";
		const who = message.role === "user" ? "you" : (message.model ?? "assistant");
		lines.push(`[${time}] ${who}:\n${textOf(message.content).trim()}\n`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("utree", {
		description: "Conversation view (like /tree: user + final assistant responses only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				console.log(plainTranscript(ctx.sessionManager as never));
				return;
			}

			const tree = pruneTree(ctx.sessionManager.getTree() as SessionTreeNode[]);
			if (tree.length === 0) {
				ctx.ui.notify("Nothing to show on this branch yet", "warning");
				return;
			}
			const currentId = nearestKeptId(ctx.sessionManager as never);

			const navigate = async (entryId: string): Promise<void> => {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the agent to finish before navigating", "warning");
					return;
				}
				// Mirror /tree's "Summarize branch?" prompt
				while (true) {
					const choice = await ctx.ui.select("Summarize branch?", [
						"No summary",
						"Summarize",
						"Summarize with custom prompt",
					]);
					if (choice === undefined) {
						await open(); // escape -> back to the tree
						return;
					}
					let customInstructions: string | undefined;
					if (choice === "Summarize with custom prompt") {
						customInstructions = await ctx.ui.editor("Custom summarization instructions");
						if (customInstructions === undefined) continue; // cancelled -> summary prompt again
					}
					const result = await ctx.navigateTree(entryId, {
						summarize: choice !== "No summary",
						customInstructions,
					});
					if (result.cancelled) {
						ctx.ui.notify("Navigation cancelled", "warning");
					}
					return;
				}
			};

			const open = (): Promise<void> =>
				ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
					const selector = new TreeSelectorComponent(
						tree,
						currentId,
						process.stdout.rows ?? 40,
						(entryId) => {
							done(); // close the selector first, like /tree
							void navigate(entryId);
						},
						() => done(),
						// Label changes are display-only here: extensions get a read-only
						// session manager, so they cannot persist label changes.
						() => {},
						currentId ?? undefined,
					);
					return selector;
				});

			await open();
		},
	});
}
