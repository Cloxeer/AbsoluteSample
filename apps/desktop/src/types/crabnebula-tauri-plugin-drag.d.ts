declare module "@crabnebula/tauri-plugin-drag" {
  export interface StartDragOptions {
    item: string[];
    icon: string;
  }
  export function startDrag(options: StartDragOptions): Promise<void>;
}
