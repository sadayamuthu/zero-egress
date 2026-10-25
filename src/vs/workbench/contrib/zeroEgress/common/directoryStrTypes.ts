import { URI } from '../../../../base/common/uri.js';

export type ZeroEgressDirectoryItem = {
	uri: URI;
	name: string;
	isSymbolicLink: boolean;
	children: ZeroEgressDirectoryItem[] | null;
	isDirectory: boolean;
	isGitIgnoredDirectory: false | { numChildren: number }; // if directory is gitignored, we ignore children
}
