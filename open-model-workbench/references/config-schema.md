# Workbench Configuration

Place an optional `composer.json` beside the source models. Without this file, the generator discovers every `.glb` and `.gltf` below the input directory and spaces the models along the X axis.

## Root Fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `pageTitle` | string | `Model Workbench` | Browser title and local persistence namespace |
| `language` | string | `zh-CN` | Document language |
| `background` | `#RRGGBB` | `#111411` | Initial stage background |
| `grid` | boolean | `true` | Initial grid visibility |
| `safeFrame` | boolean | `true` | Initial capture-frame visibility |
| `capture` | object | see below | Clean capture dimensions |
| `models` | object[] | required | One or more model instances |

## Capture

- `width`: integer from 1024 to 3840; default `1920`.
- `height`: integer from 720 to 2160; default `1080`.
- Dimensions must use a desktop landscape ratio from 1.3 to 2.4.
- `background`: reserved capture color in `#RRGGBB` format.

## Model Entry

| Field | Type | Default | Purpose |
|---|---|---|---|
| `id` | string | filename slug | Unique lowercase identifier using letters, digits, and hyphens |
| `label` | string | filename | Object-list label |
| `model` | string | required | GLB/GLTF path relative to the input directory |
| `position` | number[3] | automatic | World position, each component from -20 to 20 |
| `rotation` | number[3] | `[0,0,0]` | Initial Euler rotation in degrees |
| `scale` | number | `1` | Normalized composition scale from 0.1 to 5 |

## Example

```json
{
  "pageTitle": "Product Composition",
  "background": "#111411",
  "grid": true,
  "safeFrame": true,
  "capture": { "width": 1920, "height": 1080 },
  "models": [
    {
      "id": "hero-product",
      "label": "Hero Product",
      "model": "product.glb",
      "position": [-1.2, 0, 0],
      "rotation": [0, -18, 0],
      "scale": 0.9
    },
    {
      "id": "support-product",
      "label": "Support Product",
      "model": "product.glb",
      "position": [1.4, -0.2, -0.3],
      "rotation": [0, 24, 0],
      "scale": 0.65
    }
  ]
}
```
