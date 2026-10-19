// Runs inside each child. Add your own authorized business logic here.
// Return true ONLY when a real task was completed; the placeholder does nothing.
// workerId is the supervisor slot UUID used in heartbeat, not an authentication token.
export async function performTask({ config, signal, workerId }) {
  void config; void signal; void workerId;
  return false;
}
