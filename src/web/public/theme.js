// Applies the saved theme before the app loads, so the page does not flash. Kept external for the CSP.
try {
  const t = localStorage.getItem("keepwatch-theme") || "system";
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch {}
