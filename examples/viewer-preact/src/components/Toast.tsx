interface ToastProps {
  message: string;
  type?: "success" | "error" | "info";
  onClose?: () => void;
}

export function Toast({ message, type = "info", onClose }: ToastProps) {
  // New styles matching the clean browser theme
  const styles = {
    success: "bg-green-100 border-green-200 text-green-800",
    error: "bg-red-100 border-red-200 text-red-800",
    info: "bg-blue-100 border-blue-200 text-blue-800",
  };

  return (
    // Positioned at the top-right now
    <div class="fixed top-6 right-6 animate-fade-in z-50">
      <div
        class={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg max-w-sm ${styles[type]}`}
      >
        <span class="text-sm font-sans font-semibold truncate">{message}</span>
        {onClose && (
          <button
            onClick={onClose}
            class="flex-shrink-0 text-current opacity-70 hover:opacity-100 transition-opacity"
          >
            <svg
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
