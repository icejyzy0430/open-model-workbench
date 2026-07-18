---
name: open-model-workbench
description: Open a ready-to-use local 3D model composition workbench for GLB or GLTF files. Use when the user says "打开模型工作台", asks to place, rotate, scale, arrange, or frame one or more 3D models, or needs a clean composition screenshot before website or Image 2 design. If the user has not supplied a model, request GLB/GLTF files first; after models are available, generate the workspace, start its localhost server, and open it automatically.
---

# Open Model Workbench

Turn user-provided GLB/GLTF files into a self-contained desktop composition workspace. Keep this task separate from point-cloud rendering or landing-page generation.

## Activation Flow

1. Inspect the current request, attachments, and explicit local paths for `.glb` or `.gltf` files.
2. If no model is available, ask only: `请提供一个或多个 GLB/GLTF 模型文件。` Stop until the user provides them. Do not create placeholders and do not ask for design details.
3. Once at least one model is available, choose an output folder outside the model source and the installed Skill. Prefer `<project>/model-workbench-output`.
4. Run the launcher with every supplied file or one directory containing the models:

```bash
python "<skill-dir>/scripts/launch_workbench.py" "<model-or-directory>" --output "<output-dir>"
```

5. Read `WORKBENCH_URL` from stdout. Confirm it returns HTTP 200 before reporting success.
6. The launcher opens the system browser by default. When a browser-control surface is already available, pass `--no-open` and navigate that browser to `WORKBENCH_URL` instead.
7. Return the clickable URL and the generated output path. Do not continue into website design unless the user asks.

## Interaction Contract

- Drag the selected model directly in translate mode.
- Press `E` to toggle translate and local-axis rotate modes.
- Press `F` to move the selected model to the stage center while preserving rotation.
- Press `G` to restore the selected model's initial rotation while preserving position.
- Use the object list to select among multiple models.
- Use numeric position/rotation controls and the scale slider for precise placement.
- Export a clean PNG capture and `model-workbench-layout.json` from the top toolbar.

## Input Rules

- Accept one or more `.glb` or `.gltf` files and directories containing them.
- Copy source models and local GLTF dependencies; never modify, rename, or delete the originals.
- When one directory contains `composer.json`, honor it. Otherwise discover all models automatically and spread them along the X axis.
- For custom initial transforms or capture dimensions, read [references/config-schema.md](references/config-schema.md).

## Runtime Rules

- Serve only on `127.0.0.1`; never expose the workbench to the network by default.
- Use HTTP, not `file://`, because ES modules and GLTF loading require a local server.
- Reuse a healthy existing server for the same output directory. Choose a free port when starting a new server.
- Do not claim the workbench is open until its URL responds successfully.
- Keep the generated workspace self-contained and offline: models, Three.js, loaders, Draco, controls, and icons must all be local.

## Direct Generation

Generate files without launching a server only when explicitly requested:

```bash
python "<skill-dir>/scripts/generate_workbench.py" "<input-dir>" "<output-dir>"
```
