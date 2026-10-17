import { localize as t } from "./ui/locale/preference.ts";

export function gitWriteFeedback(reason: string) {
  const messages: Record<string, [string, string]> = {
    stage: ["已暂存文件。", "File staged."], unstage: ["已取消暂存，工作区内容保留。", "File unstaged. Working content preserved."],
    commit: ["提交成功。", "Commit created."], "create-branch": ["分支已创建。", "Branch created."], "switch-branch": ["已切换分支。", "Branch switched."],
    state_changed: ["仓库状态已变化，已刷新；请检查后重新操作。", "Repository changed. Review the refreshed state before trying again."],
    busy: ["Git 操作正在进行，请稍后刷新。", "A Git operation is in progress. Refresh shortly."],
    agent_busy: ["共用此工作树的聊天正在运行，请等待回复结束。", "A chat sharing this working tree is running. Wait for it to finish."],
    session_changed: ["聊天已切换，请返回原聊天检查仓库状态。", "Chat switched. Return to the original chat to check the repository."],
    root_required: ["提交和切换分支请在仓库根目录工作区操作。", "Open the repository root workspace to commit or switch branches."],
    operation_in_progress: ["请先在终端完成冲突处理或正在进行的 Git 操作。", "Finish conflict resolution or the ongoing Git operation in the terminal first."],
    index_locked: ["Git 锁被占用，请等待其他 Git 操作完成。", "Git is locked. Wait for other Git operations to finish."],
    too_many_changes: ["仓库改动或分支过多，请在终端操作。", "Too many changes or branches. Use the terminal for this operation."],
    dirty_worktree: ["切换分支前请先提交或处理全部改动，包括未跟踪文件。", "Commit or resolve all changes, including untracked files, before switching branches."],
    nothing_staged: ["请先暂存要提交的文件。", "Stage files before committing."],
    identity_missing: ["请先在终端配置 Git user.name 和 user.email。", "Configure Git user.name and user.email in the terminal first."],
    invalid_branch: ["分支名称无效，请检查后重试。", "Invalid branch name. Check the name and try again."],
    branch_exists: ["同名分支已存在。", "A branch with this name already exists."],
    branch_in_use: ["该分支正在其他工作树中使用。", "This branch is checked out in another worktree."],
    no_commits: ["创建分支前请先完成首次提交。", "Create an initial commit before creating a branch."],
    invalid_path: ["该文件不支持此操作，请刷新检查。", "This file cannot be changed here. Refresh and check it."],
    invalid_message: ["请填写提交说明（最多 8 KB）。", "Enter a commit message (up to 8 KB)."],
    git_failed: ["Git 操作失败。请检查仓库、身份、签名或 hooks 配置，再刷新确认。", "Git operation failed. Check repository, identity, signing or hooks configuration, then refresh."],
    outcome_unknown: ["未能确认操作结果。请刷新检查暂存区、历史和分支，确认前不要重复提交。", "Operation outcome is unknown. Refresh and check staging, history and branches before repeating it."],
  };
  const message = messages[reason] ?? messages.git_failed!;
  return t(...message);
}
