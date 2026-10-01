import type { Ref } from "preact";

// The prompts stacked at the bottom right: a blocked new-tab URL, pending
// downloads, a file-upload request and a mic-access request. Each stacks
// above the ones before it (76 px apart).

type Download = { filename: string; guid: string; url: string };

export function HijackedUrlPrompt({ url, onOpen, onDismiss }: { url: string; onOpen: () => void; onDismiss: () => void }) {
  return (
<div
  class="fixed bottom-6 right-6 z-50 cursor-pointer animate-fade-in"
  onClick={onOpen}
>
  <div class="flex items-center gap-4 px-4 py-3 rounded-lg border-2 border-black shadow-lg bg-yellow-100 text-yellow-800">
    <div class="flex-shrink-0">
      <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fill-rule="evenodd"
          d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.428a1 1 0 00.475 0l5 1.428a1 1 0 001.17-1.409l-7-14zM10 4.868L12.89 10.612 10 9.788l-2.89 2.824L10 4.868z"
          clip-rule="evenodd"
        />
      </svg>
    </div>
    <div class="text-sm font-bold">
      <p>Blocked navigation to a new URL.</p>
      <p class="font-mono text-xs truncate max-w-xs">{url}</p>
      <p class="font-semibold text-blue-600 hover:underline">
        Click here to open in a new tab.
      </p>
    </div>
    <button
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
      class="flex-shrink-0 text-current opacity-70 hover:opacity-100"
    >
      {" "}
      &times;{" "}
    </button>
  </div>
</div>
  );
}

// Download prompts: stacked, not
// just the newest, since each is its own claim. A real <a download> anchor
// makes the click itself the browser's save trigger (the backend's
// Content-Disposition supplies the filename; `download` is the fallback), so
// no fetch state is needed here.
export function DownloadPrompts({ downloads, onDone }: { downloads: Download[]; onDone: (guid: string) => void }) {
  return (
    <>
      {downloads.map((dl) => (
        <div
          key={dl.guid}
          class="fixed bottom-6 right-6 z-50 animate-fade-in"
          style={{ marginBottom: `${downloads.indexOf(dl) * 76}px` }}
        >
          <div class="flex items-center gap-4 px-4 py-3 rounded-lg border-2 border-black shadow-lg bg-blue-100 text-blue-800">
            <div class="flex-shrink-0">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
              </svg>
            </div>
            <div class="text-sm font-bold">
              <p>A file is ready to download.</p>
              <a
                href={dl.url}
                download={dl.filename}
                class="font-mono text-xs truncate max-w-xs block text-blue-600 hover:underline"
                onClick={() => onDone(dl.guid)}
              >
                {dl.filename}
              </a>
            </div>
            <button
              onClick={() => onDone(dl.guid)}
              class="flex-shrink-0 text-current opacity-70 hover:opacity-100"
            >
              {" "}
              &times;{" "}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

type UploadPromptProps = {
  multiple: boolean;
  uploading: boolean;
  uploadError: string | null;
  offset: number;
  fileInputRef: Ref<HTMLInputElement>;
  onFilesPicked: (e: Event) => void;
  onDismiss: () => void;
};

// Upload prompt: one at a time, as a
// browser shows one file picker at once. The visible button forwards its
// click to the hidden <input type="file">, which raises the OS picker; the
// indirection only exists so the button can match the other prompts.
export function UploadPrompt({ multiple, uploading, uploadError, offset, fileInputRef, onFilesPicked, onDismiss }: UploadPromptProps) {
  return (
<div class="fixed bottom-6 right-6 z-50 animate-fade-in" style={{ marginBottom: `${offset * 76}px` }}>
  <div class="flex items-center gap-4 px-4 py-3 rounded-lg border-2 border-black shadow-lg bg-green-100 text-green-800">
    <div class="flex-shrink-0">
      <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
        <path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z" />
        <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
      </svg>
    </div>
    <div class="text-sm font-bold">
      <p>The page wants a file{multiple ? "(s)" : ""}.</p>
      {uploadError ? (
        <p class="font-mono text-xs text-red-700 max-w-xs">{uploadError}</p>
      ) : uploading ? (
        <p class="font-mono text-xs">Uploading…</p>
      ) : (
        <button
          onClick={() => (fileInputRef as { current: HTMLInputElement | null }).current?.click()}
          class="font-semibold text-green-700 hover:underline"
        >
          Choose file{multiple ? "s" : ""}…
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple={!!multiple}
        onChange={onFilesPicked}
        hidden
      />
    </div>
    <button
      onClick={onDismiss}
      class="flex-shrink-0 text-current opacity-70 hover:opacity-100"
    >
      {" "}
      &times;{" "}
    </button>
  </div>
</div>
  );
}

type MicPromptProps = {
  origin: string;
  micError: string | null;
  micGranting: boolean;
  offset: number;
  onAllow: () => void;
  onDeny: () => void;
  onDismiss: () => void;
};

// Mic access prompt. Unlike the
// others, the remote page's own JS is blocked waiting for this; Allow and
// Deny both resolve it at once over signaling.
export function MicPrompt({ origin, micError, micGranting, offset, onAllow, onDeny, onDismiss }: MicPromptProps) {
  return (
<div class="fixed bottom-6 right-6 z-50 animate-fade-in" style={{ marginBottom: `${offset * 76}px` }}>
  <div class="flex items-center gap-4 px-4 py-3 rounded-lg border-2 border-black shadow-lg bg-blue-100 text-blue-800">
    <div class="flex-shrink-0">
      <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
        <path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3z" />
        <path d="M5.5 9.643a.75.75 0 00-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-1.5v-1.546A6.001 6.001 0 0016 10v-.357a.75.75 0 00-1.5 0V10a4.5 4.5 0 01-9 0v-.357z" />
      </svg>
    </div>
    <div class="text-sm font-bold">
      <p>
        <span class="font-mono text-xs opacity-70">{origin}</span> wants to use your microphone.
      </p>
      {micError ? (
        <>
          <p class="font-mono text-xs text-red-700 max-w-xs">{micError}</p>
          <button
            onClick={onDismiss}
            class="font-semibold text-blue-700 hover:underline mt-1"
          >
            Dismiss
          </button>
        </>
      ) : micGranting ? (
        <p class="font-mono text-xs">Requesting microphone…</p>
      ) : (
        <div class="flex gap-3 mt-1">
          <button onClick={onAllow} class="font-semibold text-blue-700 hover:underline">
            Allow
          </button>
          <button onClick={onDeny} class="font-semibold text-blue-700 hover:underline">
            Deny
          </button>
        </div>
      )}
    </div>
  </div>
</div>
  );
}
