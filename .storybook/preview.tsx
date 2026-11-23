import type { Preview } from "@storybook/react";
import "../packages/ui/src/index.css";

const preview: Preview = {
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  tags: ["autodocs"],
};

export default preview;
