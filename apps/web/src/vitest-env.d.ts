/// <reference types="vite/client" />
// Brings toBeInTheDocument and friends into the type checker. Without it the
// matchers work at runtime but tsc rejects every assertion that uses one.
/// <reference types="@testing-library/jest-dom" />
