// The image builder replaces this fail-closed placeholder with a tenant pin.
// The measured image digest then binds the account and the owner's legacy lock.
export const deploymentPin = Object.freeze({ ownerId: null, fingerprint: null });
