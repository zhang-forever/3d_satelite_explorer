import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".next/**", ".next-static/**", "out/**", "cloud/**", "node_modules/**", "coverage/**", ".cache/**", "dist/**", "public/textures/**", "public/data/**"]
  },
  ...nextVitals,
];

export default eslintConfig;
