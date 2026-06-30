export const invoke = vi.fn();
export const view = {
  getContext: vi.fn().mockResolvedValue({ extension: { type: "jira:adminPage" } }),
  setAutoResizing: vi.fn(),
};
export const router = { open: vi.fn() };
export const rovo = { invoke: vi.fn() };
