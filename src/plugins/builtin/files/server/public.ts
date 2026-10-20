/** Bounded workspace reads shared by file previews and Git's untracked-file diffs.
 * The Files UI toggle is not a filesystem permission and does not disable other capabilities' scoped reads.
 */
export { previewWorkspaceFile, WorkspaceFileError } from "./workspace-files.ts";
