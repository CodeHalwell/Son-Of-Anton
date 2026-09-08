export declare class WorkspacePathError extends Error {
}
/** Resolve relative or absolute workspace paths and reject every symlink component. */
export declare function workspacePath(root: string, input: string, allowRoot?: boolean): Promise<string>;
/** Read through a non-following file handle; only absence represents a missing file. */
export declare function readWorkspaceFile(root: string, input: string): Promise<string | undefined>;
/** Replace files atomically, avoiding truncation through symlinks or hard links. */
export declare function writeWorkspaceFile(root: string, input: string, content: string): Promise<void>;
export declare function removeWorkspaceFile(root: string, input: string): Promise<void>;
