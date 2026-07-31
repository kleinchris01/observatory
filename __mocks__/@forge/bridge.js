export const invoke = vi.fn();
export const view = {
  getContext: vi.fn().mockResolvedValue({ extension: { type: "jira:adminPage" } }),
  setAutoResizing: vi.fn(),
};
export const router = { open: vi.fn() };
// `open` is what openFieldExpertRovo actually calls. Its absence here meant every
// Ask Rovo path was untestable, which is how a broken call site survived.
export const rovo = { invoke: vi.fn(), open: vi.fn().mockResolvedValue(undefined) };
