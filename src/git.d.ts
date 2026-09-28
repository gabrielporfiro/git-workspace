import { Uri } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}

export interface Git {
  readonly path: string;
}

export interface API {
  readonly git: Git;
  readonly repositories: Repository[];
  getRepository(uri: Uri): Repository | null;
  openRepository(root: Uri): Promise<Repository | null>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  pull(unshallow?: boolean): Promise<void>;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
}

export interface Branch {
  readonly name?: string;
  readonly upstream?: { remote: string; name: string };
}

export interface Remote {
  readonly name: string;
}

export type GitError = Error & {
  stderr?: string;
  gitErrorCode?: string;
};
