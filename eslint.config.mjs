import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".next/**", ".next-static/**", "out/**", "cloud/**", "node_modules/**", "coverage/**", ".cache/**", "dist/**", "public/textures/**", "public/data/**"]
  },
  ...nextVitals,
  {
    // Next.js 16 ships the React Compiler lint rules. This project does not
    // enable the compiler, and the worker-lifecycle / clock effects below are
    // intentional: they reset state when inputs change or report a failed
    // Worker construction. Disabling the compiler-only rules keeps the signal
    // on the rules that matter for correctness here.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off"
    }
  }
];

export default eslintConfig;
