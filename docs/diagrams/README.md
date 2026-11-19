# Diagrams

Every diagram in the documentation is kept here twice:

- **`<name>.mmd`**, the source, written in [Mermaid](https://mermaid.js.org/). This is the one to edit.
- **`<name>.png`**, the image the documents show.

The documents show images rather than Mermaid code because Mermaid is not displayed reliably everywhere. GitHub's own Mermaid display can fail ("Unable to render rich display"), and some tools, editors and document viewers don't support Mermaid at all. A PNG shows the same everywhere, including in the install kit.

Each image in a document is followed by a hidden note naming its source file. The name starts with the document it belongs to, for example `readme-…` or `design-…`.

## Changing a diagram

1. Edit the `.mmd` file.
2. Draw the image again, with the same settings as the others: Mermaid 11, default theme, natural width (`useMaxWidth: false`), white background, at twice the normal size. Either:
   - with the Mermaid command-line tool, from the repository folder:

     ```bash
     docker run --rm -v "$PWD/docs/diagrams:/data" minlag/mermaid-cli -i /data/<name>.mmd -o /data/<name>.png -b white -s 2
     ```

   - or paste the source into the [Mermaid Live Editor](https://mermaid.live), check it, and download the PNG.
3. Look at the image, then commit the `.mmd` and the `.png` together.

## Adding a diagram

Create `<document>-<topic>.mmd` here, draw its PNG as above, and show it in the document like this:

```markdown
![What the diagram shows](../diagrams/<name>.png)

<!-- Diagram source: ../diagrams/<name>.mmd. Edit it, then redraw the image: see docs/diagrams/README.md -->
```

Don't put Mermaid code directly in a document. `node --test scripts/` checks that every source has an image, that every image a document shows exists, and that no document contains Mermaid code.

## Editable draw.io versions

Two diagrams also have a `.drawio` version, for slides and hand-outs. They are not shown in the documents and are not checked by the tests.

| File | Shows |
| --- | --- |
| `readme-the-six-workflows.drawio` | How the six workflows call each other, with RBIS, the summary email and the worklist |
| `readme-what-each-workflow-does.drawio` | One card per workflow: its purpose, what starts it, what it does, and what it replaces in UiPath |

Open them at [app.diagrams.net](https://app.diagrams.net) (**File → Open from → Device**), in the draw.io desktop app, or in VS Code with the **Draw.io Integration** extension. Export a PNG or SVG from there. If a workflow changes, update its `.drawio` version along with the `.mmd`.
