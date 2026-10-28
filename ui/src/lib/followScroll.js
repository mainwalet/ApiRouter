// Whether the transcript keeps following a streaming reply. Only the reader moving up lets go of the bottom;
// a layout change (keyboard, composer resize, a code block landing) must not, or the view stops following.
export function nextStick(stick, near, movedUp) {
  if (near) return true;
  return movedUp ? false : stick;
}
