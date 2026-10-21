import { contextBridge, ipcRenderer } from "electron";

export type HostsProfileType = "user" | "remote";

export interface HostsProfileDto {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  type: HostsProfileType;
  /** Remote source URL (type === "remote"). */
  url?: string;
  /** Epoch ms of the last successful remote refresh. */
  fetchedAt?: number;
}

export interface HostsStateDto {
  theme: "light" | "dark";
  /** Whether only one profile may be enabled at a time. */
  exclusive: boolean;
  profiles: HostsProfileDto[];
  /** Current on-disk system hosts content (read-only view). */
  systemContent: string;
  /** Resolved system hosts path, for display. */
  systemPath: string;
}

export interface HostsApplyResult {
  ok: boolean;
  /** "direct" wrote in place; "elevated" used a UAC prompt. */
  method?: "direct" | "elevated";
  message?: string;
  /** True when the user cancelled the UAC prompt. */
  cancelled?: boolean;
  systemContent?: string;
}

export interface HostsMutationResult {
  ok: boolean;
  message?: string;
  state?: HostsStateDto;
}

contextBridge.exposeInMainWorld("hosts", {
  onState: (callback: (state: HostsStateDto) => void) =>
    ipcRenderer.on("hosts:state", (_event, state: HostsStateDto) => callback(state)),
  requestState: (): Promise<HostsStateDto> => ipcRenderer.invoke("hosts:request-state"),
  createProfile: (name: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:create", name),
  renameProfile: (id: string, name: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:rename", id, name),
  deleteProfile: (id: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:delete", id),
  setEnabled: (id: string, enabled: boolean): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:set-enabled", id, enabled),
  updateContent: (id: string, content: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:update-content", id, content),
  setExclusive: (exclusive: boolean): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:set-exclusive", exclusive),
  importRemote: (name: string, url: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:import-remote", name, url),
  refreshRemote: (id: string): Promise<HostsMutationResult> =>
    ipcRenderer.invoke("hosts:refresh-remote", id),
  apply: (): Promise<HostsApplyResult> => ipcRenderer.invoke("hosts:apply"),
  close: () => ipcRenderer.send("hosts:close"),
});
