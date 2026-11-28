interface InstallRecord {
    install_id: string;
    created_at: string;
    schema_version: 1;
}
export type InstallRecordState = {
    status: 'missing';
} | {
    status: 'unreadable';
    reason: string;
} | {
    status: 'ok';
    install_id: string;
    created_at: string | null;
};
export declare function readInstallRecordState(): InstallRecordState;
export declare function getInstallRecord(): InstallRecord;
export declare function getInstallId(): string;
export {};
//# sourceMappingURL=install-id.d.ts.map