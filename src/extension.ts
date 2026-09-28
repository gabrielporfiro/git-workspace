import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { API, GitError, GitExtension, Repository } from "./git";

const CONCURRENCY = 4;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "dist",
  "node_modules",
  "out",
  "venv",
]);

type Outcome =
  | { name: string; status: "ok" }
  | { name: string; status: "skipped"; reason: string }
  | { name: string; status: "failed"; reason: string };

interface WorkspaceGitAction {
  confirmMessage: string;
  confirmDetail?: string;
  confirmButton: string;
  progressTitle: string;
  cancelledMessage: string;
  summary: (ok: number, failed: number, skipped: number) => string;
  run: (repository: Repository, gitPath: string) => Promise<Outcome>;
}

const OUTPUT_CHANNEL = "Git Workspace";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorGitPullWorkspace.pullAll", pullAll),
    vscode.commands.registerCommand("cursorGitPullWorkspace.discardAll", discardAll),
    vscode.commands.registerCommand("cursorGitPullWorkspace.switchAll", switchAll),
    vscode.commands.registerCommand("cursorGitPullWorkspace.createBranch", createBranch),
  );
}

export function deactivate(): void {}

function pullAll(): Promise<void> {
  return runWorkspaceGitAction({
    confirmMessage: "Executar git pull em todos os repositórios do workspace?",
    confirmButton: "Pull",
    progressTitle: "Git pull nos repositórios do workspace",
    cancelledMessage: "Cancelado antes do pull.",
    summary: (ok, failed, skipped) =>
      `Pull: ${ok} atualizado(s), ${failed} com falha, ${skipped} ignorado(s).`,
    run: (repository) => pullRepository(repository),
  });
}

async function createBranch(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Nenhuma pasta aberta no workspace.");
    return;
  }

  const source = await askBranch(
    "Branch de origem",
    "A nova branch nasce da última versão remota desta branch",
    "main",
  );
  if (!source) {
    return;
  }
  const created = await askBranch("Nova branch", "Nome da branch que será criada", "feature/nome");
  if (!created) {
    return;
  }
  if (source === created) {
    void vscode.window.showErrorMessage("A nova branch precisa ter um nome diferente da origem.");
    return;
  }

  let loaded: { api: API; repositories: Repository[] };
  try {
    loaded = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Localizando repositórios",
      },
      (_progress, token) => loadRepositories(folders, token),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(errorText(error));
    return;
  }
  if (loaded.repositories.length === 0) {
    void vscode.window.showWarningMessage("Nenhum repositório Git encontrado no workspace.");
    return;
  }

  const selected = await pickRepositories(loaded.repositories);
  if (!selected) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Criar ${created} a partir da última versão de ${source} em ${selected.length} repositório(s)?`,
    { modal: true, detail: repositoryList(selected) },
    "Criar",
  );
  if (confirmed !== "Criar") {
    return;
  }

  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  output.clear();
  output.show(true);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Criando ${created} a partir de ${source}`,
      cancellable: true,
    },
    (progress, token) =>
      executeRepositories(
        loaded.api,
        selected,
        {
          confirmMessage: "",
          confirmButton: "Criar",
          progressTitle: `Criando ${created} a partir de ${source}`,
          cancelledMessage: "Cancelado antes de criar a branch.",
          summary: (ok, failed, skipped) =>
            `Branch ${created}: ${ok} criada(s), ${failed} com falha, ${skipped} ignorado(s).`,
          run: (repository, gitPath) => createRepositoryBranch(repository, gitPath, source, created),
        },
        output,
        progress,
        token,
      ),
  );
}

async function switchAll(): Promise<void> {
  const branch = await askBranch("Trocar branch em todos os repositórios", "Nome da branch remota", "main");
  if (!branch) {
    return;
  }

  return runWorkspaceGitAction({
    confirmMessage: `Trocar todos os repositórios para a última versão remota de ${branch}?`,
    confirmDetail:
      "Cada repositório faz fetch e a branch local passa a apontar para o remoto. Commits locais dessa branch que não estão no remoto são descartados.",
    confirmButton: "Trocar",
    progressTitle: `Trocando para ${branch}`,
    cancelledMessage: "Cancelado antes de trocar a branch.",
    summary: (ok, failed, skipped) =>
      `Branch ${branch}: ${ok} trocado(s), ${failed} com falha, ${skipped} ignorado(s).`,
    run: (repository, gitPath) => switchRepository(repository, gitPath, branch),
  });
}

function discardAll(): Promise<void> {
  return runWorkspaceGitAction({
    confirmMessage: "Limpar todas as alterações em todos os repositórios do workspace?",
    confirmDetail:
      "Arquivos modificados, no stage e não rastreados serão apagados. Arquivos ignorados pelo Git permanecem. Isso não pode ser desfeito.",
    confirmButton: "Limpar",
    progressTitle: "Limpando alterações nos repositórios do workspace",
    cancelledMessage: "Cancelado antes de limpar as alterações.",
    summary: (ok, failed, skipped) =>
      `Limpeza: ${ok} repositório(s), ${failed} com falha, ${skipped} ignorado(s).`,
    run: (repository, gitPath) => discardRepository(repository, gitPath),
  });
}

async function runWorkspaceGitAction(action: WorkspaceGitAction): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Nenhuma pasta aberta no workspace.");
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    action.confirmMessage,
    { modal: true, detail: action.confirmDetail },
    action.confirmButton,
  );
  if (confirmed !== action.confirmButton) {
    return;
  }

  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  output.clear();
  output.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: action.progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      let api: API;
      try {
        api = await getGitApi();
      } catch (error) {
        const reason = errorText(error);
        output.appendLine(reason);
        void vscode.window.showErrorMessage(reason);
        return;
      }

      progress.report({ message: "Localizando repositórios..." });
      const repositories = await discoverRepositories(api, folders, token);
      if (token.isCancellationRequested) {
        output.appendLine(action.cancelledMessage);
        return;
      }
      if (repositories.length === 0) {
        output.appendLine("Nenhum repositório Git encontrado no workspace.");
        void vscode.window.showWarningMessage(
          "Nenhum repositório Git encontrado no workspace.",
        );
        return;
      }

      await executeRepositories(api, repositories, action, output, progress, token);
    },
  );
}

async function executeRepositories(
  api: API,
  repositories: Repository[],
  action: WorkspaceGitAction,
  output: vscode.OutputChannel,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (token.isCancellationRequested) {
    output.appendLine(action.cancelledMessage);
    return;
  }

  const outcomes = await mapPool(repositories, CONCURRENCY, async (repository, index) => {
    if (token.isCancellationRequested) {
      return {
        name: repositoryName(repository),
        status: "skipped" as const,
        reason: "cancelado",
      };
    }
    progress.report({
      message: `${repositoryName(repository)} (${index + 1}/${repositories.length})`,
      increment: 100 / repositories.length,
    });
    return action.run(repository, api.git.path);
  });

  for (const outcome of outcomes) {
    output.appendLine(formatOutcome(outcome));
  }

  const ok = outcomes.filter((item) => item.status === "ok").length;
  const failed = outcomes.filter((item) => item.status === "failed").length;
  const skipped = outcomes.filter((item) => item.status === "skipped").length;
  const summary = action.summary(ok, failed, skipped);
  output.appendLine(summary);

  if (failed > 0) {
    const choice = await vscode.window.showWarningMessage(summary, "Ver saída");
    if (choice === "Ver saída") {
      output.show(true);
    }
    return;
  }
  void vscode.window.showInformationMessage(summary);
}

async function loadRepositories(
  folders: readonly vscode.WorkspaceFolder[],
  token: vscode.CancellationToken,
): Promise<{ api: API; repositories: Repository[] }> {
  const api = await getGitApi();
  const repositories = await discoverRepositories(api, folders, token);
  return { api, repositories };
}

interface RepositoryPick extends vscode.QuickPickItem {
  repository: Repository;
}

function pickRepositories(repositories: Repository[]): Promise<Repository[] | undefined> {
  const picker = vscode.window.createQuickPick<RepositoryPick>();
  picker.canSelectMany = true;
  picker.title = "Repositórios";
  picker.placeholder = "Marque os serviços ou use o botão para selecionar todos";
  picker.ignoreFocusOut = true;
  picker.items = repositories.map((repository) => ({
    label: repositoryName(repository),
    description: repository.rootUri.fsPath,
    repository,
  }));
  picker.buttons = [
    {
      iconPath: new vscode.ThemeIcon("checklist"),
      tooltip: "Selecionar todos",
    },
  ];

  return new Promise((resolve) => {
    let accepted = false;
    picker.onDidTriggerButton(() => {
      picker.selectedItems = picker.items;
    });
    picker.onDidAccept(() => {
      if (picker.selectedItems.length === 0) {
        picker.placeholder = "Selecione ao menos um repositório";
        return;
      }
      accepted = true;
      const selected = picker.selectedItems.map((item) => item.repository);
      picker.hide();
      resolve(selected);
    });
    picker.onDidHide(() => {
      if (!accepted) {
        resolve(undefined);
      }
      picker.dispose();
    });
    picker.show();
  });
}

async function getGitApi(): Promise<API> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    throw new Error("A extensão Git do editor não está disponível.");
  }
  const git = extension.isActive ? extension.exports : await extension.activate();
  if (!git.enabled) {
    throw new Error("A extensão Git do editor está desabilitada.");
  }
  return git.getAPI(1);
}

async function discoverRepositories(
  api: API,
  folders: readonly vscode.WorkspaceFolder[],
  token: vscode.CancellationToken,
): Promise<Repository[]> {
  const found = new Map<string, Repository>();

  await mapPool([...folders], CONCURRENCY, async (folder) => {
    if (token.isCancellationRequested) {
      return;
    }
    const repository = await openRepository(api, folder.uri);
    if (repository) {
      found.set(repository.rootUri.fsPath, repository);
      return;
    }
    for (const child of await childRepositoryUris(folder.uri)) {
      if (token.isCancellationRequested) {
        return;
      }
      const nested = await openRepository(api, child);
      if (nested) {
        found.set(nested.rootUri.fsPath, nested);
      }
    }
  });

  return [...found.values()].sort((left, right) =>
    repositoryName(left).localeCompare(repositoryName(right)),
  );
}

async function openRepository(api: API, uri: vscode.Uri): Promise<Repository | null> {
  return api.getRepository(uri) ?? (await api.openRepository(uri));
}

async function childRepositoryUris(folder: vscode.Uri): Promise<vscode.Uri[]> {
  let entries;
  try {
    entries = await fs.readdir(folder.fsPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const uris: vscode.Uri[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const childPath = path.join(folder.fsPath, entry.name);
    try {
      await fs.access(path.join(childPath, ".git"));
      uris.push(vscode.Uri.file(childPath));
    } catch {
      continue;
    }
  }
  return uris;
}

async function discardRepository(repository: Repository, gitPath: string): Promise<Outcome> {
  const name = repositoryName(repository);
  const cwd = repository.rootUri.fsPath;
  try {
    await execGit(gitPath, ["reset", "--hard", "HEAD"], cwd);
  } catch (error) {
    const reason = errorText(error);
    if (!isMissingHead(reason)) {
      return { name, status: "failed", reason };
    }
  }

  try {
    await execGit(gitPath, ["clean", "-fd"], cwd);
    return { name, status: "ok" };
  } catch (error) {
    return { name, status: "failed", reason: errorText(error) };
  }
}

async function createRepositoryBranch(
  repository: Repository,
  gitPath: string,
  source: string,
  created: string,
): Promise<Outcome> {
  const name = repositoryName(repository);
  const remote = trackingRemote(repository);
  if (!remote) {
    return { name, status: "skipped", reason: "sem remote" };
  }

  const cwd = repository.rootUri.fsPath;
  const remoteRef = `refs/remotes/${remote}/${source}`;
  try {
    await execGit(gitPath, ["fetch", remote, `refs/heads/${source}:${remoteRef}`], cwd);
    await execGit(gitPath, ["switch", "-c", created, "--no-track", `${remote}/${source}`], cwd);
    return { name, status: "ok" };
  } catch (error) {
    return { name, status: "failed", reason: errorText(error) };
  }
}

async function switchRepository(
  repository: Repository,
  gitPath: string,
  branch: string,
): Promise<Outcome> {
  const name = repositoryName(repository);
  const remote = trackingRemote(repository);
  if (!remote) {
    return { name, status: "skipped", reason: "sem remote" };
  }

  const cwd = repository.rootUri.fsPath;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  try {
    await execGit(
      gitPath,
      ["fetch", remote, `refs/heads/${branch}:${remoteRef}`],
      cwd,
    );
    await execGit(gitPath, ["switch", "-C", branch, "--track", `${remote}/${branch}`], cwd);
    return { name, status: "ok" };
  } catch (error) {
    return { name, status: "failed", reason: errorText(error) };
  }
}

function trackingRemote(repository: Repository): string | undefined {
  const names = repository.state.remotes.map((remote) => remote.name);
  if (names.includes("origin")) {
    return "origin";
  }
  return names[0];
}

async function askBranch(title: string, prompt: string, placeHolder: string): Promise<string | undefined> {
  const informed = await vscode.window.showInputBox({
    title,
    prompt,
    placeHolder,
    ignoreFocusOut: true,
  });
  const branch = informed?.trim() ?? "";
  if (!branch) {
    return undefined;
  }
  if (!isBranchName(branch)) {
    void vscode.window.showErrorMessage(`Nome de branch inválido: ${branch}`);
    return undefined;
  }
  return branch;
}

function repositoryList(repositories: Repository[]): string {
  const names = repositories.map(repositoryName);
  if (names.length <= 12) {
    return names.join(", ");
  }
  return `${names.slice(0, 12).join(", ")} e mais ${names.length - 12}`;
}

function isBranchName(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

function isMissingHead(reason: string): boolean {
  return /ambiguous argument 'HEAD'|unknown revision|needed a single revision/i.test(reason);
}

function execGit(gitPath: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

async function pullRepository(repository: Repository): Promise<Outcome> {
  const name = repositoryName(repository);
  const head = repository.state.HEAD;
  if (repository.state.remotes.length === 0) {
    return { name, status: "skipped", reason: "sem remote" };
  }
  if (!head?.name) {
    return { name, status: "skipped", reason: "HEAD desanexado ou repositório vazio" };
  }
  if (!head.upstream) {
    return {
      name,
      status: "skipped",
      reason: `branch ${head.name} sem upstream`,
    };
  }

  try {
    await repository.pull();
    return { name, status: "ok" };
  } catch (error) {
    return { name, status: "failed", reason: errorText(error) };
  }
}

function repositoryName(repository: Repository): string {
  return path.basename(repository.rootUri.fsPath);
}

function formatOutcome(outcome: Outcome): string {
  if (outcome.status === "ok") {
    return `[ok] ${outcome.name}`;
  }
  if (outcome.status === "skipped") {
    return `[ignorado] ${outcome.name} — ${outcome.reason}`;
  }
  return `[falha] ${outcome.name} — ${outcome.reason}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const gitError = error as GitError;
    const stderr = gitError.stderr?.trim();
    return stderr && !error.message.includes(stderr) ? `${error.message} ${stderr}` : error.message;
  }
  return String(error);
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
