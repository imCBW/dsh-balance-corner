/**
 * Host half of the balance bundle.
 *
 * The plugin has no host-side work: the browser half reads the account balance
 * through the existing `remote.account` service and renders it in the composer
 * tool row. This entry only exists because every bundle mounts a host plugin.
 */
export function apply() {}
