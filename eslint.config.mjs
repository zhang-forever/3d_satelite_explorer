import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", ".cache/**", "dist/**", "public/textures/**"]
  },
  ...nextVitals,
];

export default eslintConfig;
