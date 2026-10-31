import assert from "node:assert/strict";
import { it } from "node:test";

import { foreignProse } from "./language.mjs";

const lines = (text) => foreignProse(text).map(({ line }) => line);

it("accepts English prose", () => {
  assert.deepEqual(
    foreignProse(
      "The module reads the configuration from the file that you pass, and it fails when a key is missing.\n",
    ),
    [],
  );
});

it("flags a French paragraph with its first line", () => {
  assert.deepEqual(
    lines(
      "The first paragraph is English and fine for the reader.\n\nCe module lit la configuration dans le fichier que vous passez, et il échoue quand une clé est absente.\n",
    ),
    [3],
  );
});

it("flags Spanish, German, Italian and Portuguese paragraphs", () => {
  for (const text of [
    "Este módulo lee la configuración del archivo que usted pasa y falla cuando no hay una clave para el servidor.",
    "Dieses Modul liest die Konfiguration aus der Datei, die Sie angeben, und schlägt fehl, wenn ein Schlüssel nicht vorhanden ist.",
    "Questo modulo legge la configurazione dal file che passi e non funziona quando una chiave è assente per il server.",
    "Este módulo lê a configuração do arquivo que você passa e não funciona quando uma chave está ausente para o servidor.",
  ])
    assert.deepEqual(lines(`${text}\n`), [1], text);
});

it("flags prose in a script other than Latin", () => {
  assert.deepEqual(
    lines("Этот модуль читает конфигурацию из файла, который вы передаёте.\n"),
    [1],
  );
  assert.deepEqual(
    lines("このモジュールは渡したファイルから設定を読み込みます。\n"),
    [1],
  );
});

it("ignores fences, inline code, comments, HTML tags and URLs", () => {
  const text = [
    "Run `le fichier de configuration est lu par la commande` first, with the flag set.",
    "",
    "```text",
    "Ce module lit la configuration dans le fichier que vous passez, et il échoue.",
    "```",
    "",
    "<!-- Ce module lit la configuration dans le fichier que vous passez, et il échoue. -->",
    "",
    "See [the guide](https://example.com/le-guide-de-la-configuration-pour-les-utilisateurs) for the details of the flag.",
    "",
  ].join("\n");
  assert.deepEqual(foreignProse(text), []);
});

it("keeps an English paragraph that quotes a foreign phrase", () => {
  assert.deepEqual(
    foreignProse(
      'The error message reads "le fichier est introuvable" when the file is missing, and the command exits with code 2.\n',
    ),
    [],
  );
});

it("does not count one repeated word as a language", () => {
  assert.deepEqual(
    foreignProse(
      "It needs no other module: no Redis, no database, no API module.\n",
    ),
    [],
  );
});

it("skips a block of fewer than five words", () => {
  assert.deepEqual(foreignProse("## Démarrage rapide\n"), []);
});
