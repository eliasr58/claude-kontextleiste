# Kontextleiste für Claude Code

Eine Zeile über dem Eingabefeld, die live zeigt, wie voll das Kontextfenster der Sitzung ist, und wie weit das 5-Stunden- und das Wochenlimit des Kontos ausgeschöpft sind.

```
━━━━━━━━━━━━━━━━━━━━━━│━──────── 62 % · noch 18 % bis Kompaktierung  5h 23 %  W 42 %  ●●●●
```

## Was die Leiste zeigt

- **Balken nach Inhalt:** Der belegte Teil ist nach dem eingefärbt, was ihn füllt: System (grau), Tools und MCP (violett), Skills (grün), Nachrichten (blau). Die Punkte rechts sind die Legende in derselben Reihenfolge.
- **Kompaktier-Marke:** Der rote Strich steht dort, wo die Sitzung automatisch zusammenfasst. Dahinter steht, wie viel Prozent bis dahin noch frei sind. Ist die automatische Kompaktierung aus, entfallen Marke und Restweg.
- **Ampel:** Prozentwerte werden ab 60 % gelb und ab 85 % rot.
- **Limits über Sitzungen hinweg:** Jede Sitzung legt den neuesten Limitstand geräteweit ab, alle anderen Sitzungen auf demselben Rechner übernehmen ihn innerhalb von 15 Sekunden. Ist ein Wert älter als 2 Minuten, steht sein Alter dahinter, etwa „(vor 14 min)“.

Der Kontext wird nach jeder Modellantwort aktualisiert. Die Aufschlüsselung nach Inhalt wird lokal geschätzt und kostet keine Tokens.

## Installation

In einer Claude-Code-Sitzung im Terminal:

```
/plugin install kontextleiste --marketplace eliasr58/claude-kontextleiste
```

Aus einer Shell:

```
claude plugin install kontextleiste --marketplace eliasr58/claude-kontextleiste
```

Danach die Frage „Add marketplace?“ mit `y` bestätigen und den Bereich „user“ wählen. In der Sitzung, in der installiert wurde, ist die Leiste sofort aktiv; jede danach gestartete Sitzung hat sie ebenfalls. In bereits laufenden Sitzungen einmal `/reload-plugins` eingeben.

In der Desktop-App, wo `/plugin` nicht läuft: neben dem Eingabefeld auf + klicken, dann Plugins, „Add marketplace“ mit `eliasr58/claude-kontextleiste`, dann „Add plugin“.

## Entwicklung

`claude plugin validate .` prüft Manifest und Modul, `claude plugin test .` führt die Tests in `hooks/kontextleiste.test.tsx` aus.
