import { ipcMain } from "electron";
import { IPC } from "../contract";
import { searchGlobal } from "../services/search.service";
import type { SearchRequest } from "../../shared/search";

export function registerSearchIPC(): void {
  ipcMain.handle(IPC.SEARCH.GLOBAL, (_event, request: SearchRequest) => searchGlobal(request));
}
