/// <reference types="vite/client" />
declare const __PUBLIC_CONFIG__: {
  cipherOrigin: string; accountOrigin: string; githubUrl: string;
  mobileLimitMB: number; fallbackLimitMB: number; reportTimezone: string;
  buildId?: string;
};

interface Window {
  showSaveFilePicker?: (options?: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
}
