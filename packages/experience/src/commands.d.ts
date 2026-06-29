export declare class ExperienceCommandHandler {
    private _draft;
    /**
     * 处理 /exp 子命令
     * @returns 回复给用户的文本
     */
    handle(args: string[]): Promise<string>;
    /** 当前是否有待确认的草稿 */
    hasDraft(): boolean;
    private handleAdd;
    private handleConfirm;
    private handleCancel;
    private handleEdit;
    private handleList;
    private handleView;
    private handleSearch;
    private handleDelete;
    private handleStats;
    private handleHelp;
    private formatDraft;
    private formatRecord;
}
export declare function getExperienceCommandHandler(): ExperienceCommandHandler;
//# sourceMappingURL=commands.d.ts.map