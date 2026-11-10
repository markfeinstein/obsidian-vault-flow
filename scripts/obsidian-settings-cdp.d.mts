export interface NativeSettingsSession {
  evaluate: (body: string) => Promise<unknown>;
  screenshot: () => Promise<string>;
  closeWindow: () => Promise<void>;
  disconnect: () => void;
}
export function connectNativeSettings(options: {
  root: string;
  profile: string;
  deadlineAt?: number;
}): Promise<NativeSettingsSession>;
