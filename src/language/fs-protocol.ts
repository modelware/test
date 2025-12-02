export const FsRequests = {
    readFile: 'oml/fs/readFile',
    stat: 'oml/fs/stat',
    readDirectory: 'oml/fs/readDirectory'
} as const;

export type FsEntryKind = 'file' | 'directory';

export type FsStatResult = {
    uri: string;
    type: FsEntryKind;
};

export type FsDirectoryEntry = {
    uri: string;
    type: FsEntryKind;
};
