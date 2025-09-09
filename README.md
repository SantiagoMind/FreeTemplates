# PDF Renderer (Render/Cloud Run)

## Endpoint
- `GET /health` ? 200 ok
- `POST /render` ? { pdf_base64 }

### Request
```json
{
  "ast": {
    "blocks": [
      {"block_id":"header","order":1,"page_break_before":false},
      {"block_id":"body","order":2}
    ],
    "byBlock": {
      "header": [
        {"type":"text","binding":"{{col:Customer}}","style_id":"h1","placeholderMode":"visible","placeholderText":"Cliente"},
        {"type":"image","binding":"{{img:Logo_DriveID}}","style_id":"logo","image_fit":"contain","placeholderMode":"visible"}
      ],
      "body": [
        {"type":"table","binding":"{{table:Items}}","style_id":"tbl","placeholderMode":"hidden"}
      ]
    },
    "styles": [
      {"style_id":"h1","font":"Roboto","size":18,"weight":"bold","align":"left","color":"#111","line_height":"1.2"},
      {"style_id":"logo","max_height":"120px","image_fit":"contain"},
      {"style_id":"tbl"}
    ],
    "tables": []
  },
  "data": {
    "Customer": "WAIAKEA",
    "Logo_DriveID": "1AbCDeFgHijkLmNoPqrStuVwXyZ",
    "Items": [["SKU","Qty","Price"],["A-01",10,20],["A-02",5,15]]
  },
  "flags": ["Flag_Header","Flag_Items"],
  "cssTokens": { "--font": "Roboto, Arial, sans-serif" },
  "options": { "page": { "size":"A4", "marginTop":"18mm","marginRight":"18mm","marginBottom":"18mm","marginLeft":"18mm" } }
}