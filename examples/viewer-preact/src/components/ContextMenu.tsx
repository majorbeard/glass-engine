import { forwardRef } from "preact/compat";

interface ContextMenuProps {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(
  ({ x, y, onCopy, onPaste, onClose }, ref) => {
    const handleCopy = () => {
      onCopy();
      onClose();
    };

    const handlePaste = () => {
      onPaste();
      onClose();
    };

    return (
      <div
        ref={ref}
        class="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl text-left min-w-[120px]"
        style={{ top: `${y}px`, left: `${x}px` }}
      >
        <ul class="py-1">
          <li>
            <button
              onClick={handleCopy}
              class="block w-full text-left px-4 py-2 text-sm text-slate-800 hover:bg-slate-100 font-sans font-semibold"
            >
              Copy
            </button>
          </li>
          <li>
            <button
              onClick={handlePaste}
              class="block w-full text-left px-4 py-2 text-sm text-slate-800 hover:bg-slate-100 font-sans font-semibold"
            >
              Paste
            </button>
          </li>
        </ul>
      </div>
    );
  }
);
