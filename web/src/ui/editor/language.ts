// Lenguaje SM83/RGBDS para CodeMirror 6 (StreamLanguage sobre sm83-tokens.ts) y su
// resaltado, con colores a juego con el tema oscuro de la app (web/src/style.css).
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { copyState, startState, token, type LineState } from "./sm83-tokens";

export const sm83Language = StreamLanguage.define<LineState>({
  name: "sm83",
  startState,
  copyState,
  token: (stream, state) => token(stream, state),
  languageData: { commentTokens: { line: ";" } },
});

export const sm83Highlight = HighlightStyle.define([
  { tag: t.comment, color: "#6b7089", fontStyle: "italic" },
  { tag: t.string, color: "#9ece6a" },
  { tag: t.number, color: "#ff9e64" },
  { tag: t.special(t.number), color: "#e0af68" },
  { tag: t.keyword, color: "#7aa2f7", fontWeight: "600" },
  { tag: t.processingInstruction, color: "#bb9af7" },
  { tag: t.typeName, color: "#2ac3de" },
  { tag: t.atom, color: "#7dcfff" },
  { tag: t.modifier, color: "#f7768e" },
  { tag: [t.definition(t.labelName), t.local(t.definition(t.labelName))], color: "#e0af68", fontWeight: "600" },
  { tag: t.labelName, color: "#c0caf5" },
  { tag: t.definition(t.variableName), color: "#ff9e64", fontWeight: "600" },
  { tag: t.definition(t.macroName), color: "#73daca", fontWeight: "600" },
  { tag: t.macroName, color: "#73daca" },
  { tag: t.special(t.variableName), color: "#f7768e" },
  { tag: t.function(t.variableName), color: "#2ac3de" },
  { tag: t.standard(t.variableName), color: "#bb9af7" },
  { tag: [t.operator, t.separator], color: "#89ddff" },
  { tag: [t.squareBracket, t.paren, t.brace], color: "#a9b1d6" },
  { tag: t.invalid, color: "#f7768e", textDecoration: "underline" },
]);

export function sm83(): Extension {
  return [sm83Language, syntaxHighlighting(sm83Highlight)];
}
