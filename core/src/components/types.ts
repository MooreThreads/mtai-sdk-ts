type DownloadStatus = {
    status: | 'pending' | 'running' | 'completed' | 'failed',
    progress: number,
    error?: string
}

export type Component = {
    url?: string,
    name: string,
    filename?: string,
    category?: string,
    description?: string,
    version?: string,
    local_version_command: string,
    install_command: string,
    auto_update?: boolean,
    install_if_missing?: boolean,
    config?: Record<string, any>
}

export type ComponentStatus = {
    local_version?: string,
    download?: DownloadStatus,
    component: Component,
}