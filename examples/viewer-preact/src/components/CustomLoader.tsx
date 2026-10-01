// The loading indicator shown while a session connects.
export const CustomLoader = () => (
  <div class="flex flex-col items-center justify-center gap-4">
    <div class="text-lg font-semibold text-slate-700">Loading Session...</div>
    <div class="flex items-center gap-2">
      <div class="w-3 h-3 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
      <div class="w-3 h-3 bg-slate-600 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
      <div class="w-3 h-3 bg-blue-500 rounded-full animate-bounce"></div>
    </div>
  </div>
);
