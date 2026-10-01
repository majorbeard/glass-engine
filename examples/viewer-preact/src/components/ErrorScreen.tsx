// Shown after an uncaught application error (see app.tsx's error listeners).
export function ErrorScreen({ error }: { error: string | null }) {
  return (
    <div class="h-screen flex items-center justify-center bg-red-50">
      <div class="text-center p-8">
        <h1 class="text-2xl font-bold text-red-600 mb-4">
          Something went wrong
        </h1>
        <p class="text-slate-700 mb-6">
          An application error occurred. Please try reloading the page.
        </p>
        <button
          onClick={() => window.location.reload()}
          class="px-5 py-2 bg-red-600 text-white rounded-lg font-semibold shadow hover:bg-red-700 transition-colors"
        >
          Reload Page
        </button>
        {error && (
          <p class="text-xs text-red-500 mt-4 p-2 bg-red-100 rounded">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
