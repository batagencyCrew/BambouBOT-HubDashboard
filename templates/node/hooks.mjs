// Runs inside each child. Add your own authorized business logic here.
// Return true ONLY when a real task was completed; the placeholder does nothing.
export async function performTask({ config, signal }) {
  void config; void signal;
  return false;
}
