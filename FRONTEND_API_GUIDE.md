# Khaoyai 304 Backend API — คู่มือเชื่อมต่อสำหรับ Frontend

## ภาพรวมฐานข้อมูลและ Worker

- Backend ใช้ตารางตาม schema ใน `sql/01-schema.sql` บัญชีใน `AppUsers` ใช้ `RoleCode`, `PasswordIterations` และ `AllowedUnderpasses` เพื่อจำกัดทางลอดที่อ่านหรือแก้ไขได้ ค่า `road_viewer` ส่งไป Frontend เป็น `road`
- ในเครื่องปิด `groupEventsWorker` และ `recordBatchFailure` เพื่อป้องกันการรับงานจากคิวที่ใช้ร่วมกัน การทดสอบอัปโหลดและจัดกลุ่มควรใช้ Storage และคิวแยกสำหรับทดสอบ

## 1. Base URL

Local:

```text
http://localhost:7071/api
```

Production:

```text
https://<BACKEND_HOST>/api
```

แนะนำให้ Frontend กำหนดผ่าน environment variable เช่น:

```env
VITE_API_BASE_URL=http://localhost:7071/api
```

หรือสำหรับ Next.js:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:7071/api
```

## 2. การยืนยันตัวตนและ Session

Backend ใช้ session cookie ชื่อ `khaoyai_session` ซึ่งเป็น `HttpOnly` ดังนั้น JavaScript จะอ่านค่า cookie โดยตรงไม่ได้ และไม่จำเป็นต้องเก็บ token ใน `localStorage` หรือ `sessionStorage`

ทุก request ที่ต้องล็อกอินต้องส่ง `credentials: "include"`:

```js
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  const body = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}
```

ข้อสำคัญเมื่อ Frontend และ Backend อยู่คนละ origin:

- Backend/Proxy ต้องอนุญาต CORS เฉพาะ origin ของ Frontend ห้ามใช้ `*` เมื่อส่ง cookie
- ต้องเปิด `Access-Control-Allow-Credentials: true`
- Production cookie ต้องใช้ `Secure; SameSite=None` หาก Frontend และ Backend เป็นคนละ site
- ให้ process ของ Backend บน VM กำหนด `NODE_ENV=production` เพื่อให้ Backend ส่ง cookie แบบ `Secure; SameSite=None`
- หากวางทั้งสองระบบหลังโดเมนเดียวกัน เช่น `https://example.com` และ proxy Backend ไว้ที่ `/api` จะจัดการ cookie และ CORS ง่ายที่สุด

## 3. บทบาทผู้ใช้

| Role | ใช้งานหลัก |
| --- | --- |
| `field_team` | เลือกกล้อง/รอบสำรวจ อัปโหลดสื่อ และดูสถานะ batch ของตนเอง และบันทึกสถานะกล้องที่ได้รับมอบหมาย |
| `reviewer` | ดูเหตุการณ์ เปิดสื่อ และบันทึกผลตรวจ |
| `researcher` | ดูเหตุการณ์ เปิดสื่อ บันทึกผลตรวจ และดูรายงาน |
| `road` | อ่านแผนที่ รายงาน และหลักฐานจากเหตุการณ์ที่ยืนยันแล้ว |
| `admin` | อัปโหลด ดูเหตุการณ์ บันทึกผลตรวจ และดูรายงาน |

หาก session ถูกต้องแต่ role ไม่มีสิทธิ์ Backend จะตอบ `403` เสมอ Frontend จึงควรซ่อนเมนูตาม `user.role` และยังต้องรองรับ `403` จาก Backend ด้วย

## 4. Auth API

### `POST /auth/login`

ตรวจชื่อผู้ใช้และรหัสผ่านกับ `AppUsers` บันทึก `SessionHash`, `UserId` และ `ExpiresAt` ใน `AppSessions` แล้วส่ง session cookie กลับมา เซสชันมีอายุ 12 ชั่วโมง

Request:

```json
{
  "username": "field.demo",
  "password": "FieldDemo304!"
}
```

Response `200`:

```json
{
  "user": {
    "id": 1,
    "username": "field.demo",
    "displayName": "ทีมภาคสนามเดโม",
    "role": "field_team"
  }
}
```

ตัวอย่าง:

```js
const result = await apiFetch("/auth/login", {
  method: "POST",
  body: JSON.stringify({ username, password }),
});
```

ถ้าข้อมูลไม่ถูกต้องจะได้ `401` พร้อม `{ "error": "Invalid username or password." }`

### `GET /auth/me`

ใช้ตรวจว่า browser มี session ที่ยังใช้งานได้หรือไม่ และดึงข้อมูลผู้ใช้ปัจจุบัน เหมาะสำหรับเรียกตอนแอปเริ่มทำงานหรือ refresh หน้า

Response `200` เหมือน `user` ใน login หากยังไม่ login หรือ session หมดอายุจะได้ `401`

```js
const { user } = await apiFetch("/auth/me");
```

### `POST /auth/logout`

ยกเลิก session ฝั่งฐานข้อมูลและล้าง cookie

Response: `204 No Content`

```js
await apiFetch("/auth/logout", { method: "POST" });
```

## 5. Catalog API

ทุก role ที่ login แล้วเรียกได้

### `GET /catalog/cameras`

อ่านกล้องพร้อมชื่อและพิกัดทางลอดจาก `Underpasses` ทีมภาคสนามเห็นเฉพาะกล้องที่ได้รับมอบหมายตาม `AllowedUnderpasses`

Response `200`:

```json
{
  "cameras": [
    {
      "id": 1,
      "code": "CAM-A-P01",
      "name": "CAM-A-P01",
      "cameraType": "photo",
      "latitude": null,
      "longitude": null,
      "underpassCode": "A",
      "underpassName": "ทางลอด A",
      "underpassLatitude": null,
      "underpassLongitude": null
    }
  ]
}
```

### `GET /catalog/rounds`

อ่านรายการรอบสำรวจสำหรับหน้าอัปโหลดและรายงาน โดยใช้วันที่เริ่มและสิ้นสุดของรอบเพื่อคำนวณสถานะเปิดตามวันไทย

Response `200`:

```json
{
  "rounds": [
    {
      "id": 1,
      "name": "รอบสำรวจที่ 1 ประจำมกราคม 2026",
      "startsOn": "2026-01-01T00:00:00.000Z",
      "endsOn": "2026-12-31T00:00:00.000Z",
      "isOpen": true
    }
  ]
}
```

หมายเหตุ: Frontend แสดงรายการได้ทั้งหมด แต่ตอนอัปโหลด Backend จะตรวจ assignment ของบัญชี `field_team` ซ้ำอีกครั้ง

### สถานะกล้อง

ทีมภาคสนามอ่านรายการเดิมด้วย `GET /coverage?roundId=1&cameraId=1&date=2026-11-11` หากยังไม่มีข้อมูลจะได้ `{"coverage": null}`

ส่ง `PUT /coverage` ด้วย `{"roundId": 1, "cameraId": 1, "date": "2026-11-11", "status": "offline", "note": "แบตเตอรี่หมด"}` ค่าสถานะคือ `active`, `offline` หรือ `unknown` ระบบบันทึกวันที่ลง `SurveyDate` และผู้บันทึกลง `RecordedBy` ใน `AppCameraCoverage` แล้วอัปเดตแถวเดิมเมื่อรอบ กล้อง และวันที่ตรงกัน

## 6. Upload API

### `POST /uploadApi`

สิทธิ์: `field_team`, `admin`

รับไฟล์ภาพ/วิดีโอ บันทึกใน Private Blob สร้างข้อมูล batch แล้วส่งงานเข้า Queue `camera-upload-jobs` เพื่อให้ worker เดิมจัดกลุ่มเหตุการณ์

ส่งแบบ `multipart/form-data` โดยมี:

| Field | รายละเอียด |
| --- | --- |
| `batchId` | UUID ที่ Frontend สร้างใหม่ต่อหนึ่งชุด upload |
| `roundId` | ID รอบสำรวจแบบจำนวนเต็ม |
| `cameraId` | ID กล้องแบบจำนวนเต็ม |
| `file` | ไฟล์ ทำซ้ำ field นี้ได้ 1–30 ไฟล์ |
| `capturedAt` | เวลา ISO 8601 พร้อม timezone ทำซ้ำตามลำดับเดียวกับ `file` |

ข้อจำกัด:

- รวมไม่เกิน 25 MiB ต่อ request
- รับเฉพาะ MIME type ที่ขึ้นต้นด้วย `image/` หรือ `video/`
- `capturedAt` ต้องมี timezone เช่น `2026-01-10T08:30:00+07:00` หรือ `2026-01-10T01:30:00Z`
- จำนวน `file` และ `capturedAt` ต้องเท่ากัน
- `field_team` ต้องถูก assign ให้กล้องและรอบนั้น
- ไม่ต้องส่ง username เพราะ Backend อ่านผู้ส่งจาก session ป้องกันการปลอมตัวเป็นผู้อื่น

ตัวอย่าง:

```js
const batchId = crypto.randomUUID();
const form = new FormData();

form.append("batchId", batchId);
form.append("roundId", String(roundId));
form.append("cameraId", String(cameraId));

for (const item of selectedFiles) {
  form.append("file", item.file);
  form.append("capturedAt", item.capturedAt.toISOString());
}

const result = await apiFetch("/uploadApi", {
  method: "POST",
  body: form,
});
```

อย่ากำหนด `Content-Type` เองเมื่อส่ง `FormData` เพราะ browser ต้องสร้าง multipart boundary ให้

Response `202`:

```json
{
  "batchId": "b9948a3a-e349-4f48-94e8-e92e99649d1d",
  "status": "queued"
}
```

Frontend ควรเก็บ `batchId` แล้ว poll สถานะผ่าน API ต่อไป

## 7. Batch API

### `GET /batches/{batchId}`

ดูสถานะงานหลัง upload โดย `field_team` จะดูได้เฉพาะ batch ที่ตนเองส่ง ส่วน `reviewer`, `researcher` และ `admin` ดูได้ทุก batch คำขอนี้อ่านข้อมูลอย่างเดียว

```js
const batch = await apiFetch(`/batches/${batchId}`);
```

ตัวอย่าง response:

```json
{
  "batchId": "b9948a3a-e349-4f48-94e8-e92e99649d1d",
  "status": "completed",
  "createdAt": "2026-11-10T06:40:00.000Z",
  "failedAt": null,
  "mediaCount": 10,
  "eventCount": 3
}
```

สถานะที่ Frontend ควรรองรับคือ `queued`, `completed` และ `failed` แนะนำ poll ทุก 2–5 วินาทีและหยุดเมื่อเป็น `completed` หรือ `failed`

## 8. Events และ Review API

### `GET /events`

สิทธิ์ `reviewer`, `researcher`, `admin` และ `road` โดย `road` อ่านเฉพาะเหตุการณ์ที่ยืนยันแล้วหรือสื่อที่ผูกกับเหตุการณ์ที่ยืนยันแล้ว

อ่านรายการเหตุการณ์ที่ worker จัดกลุ่มแล้ว รองรับ query string:

| Query | ตัวอย่าง | ความหมาย |
| --- | --- | --- |
| `cameraId` | `1` | กรองตามกล้อง |
| `roundId` | `1` | กรองตามรอบสำรวจ |
| `reviewStatus` | `pending` | กรองตามสถานะตรวจ |

ตัวอย่าง:

```js
const params = new URLSearchParams({
  roundId: String(roundId),
  reviewStatus: "pending",
});
const { events } = await apiFetch(`/events?${params}`);
```

Response:

```json
{
  "events": [
    {
      "id": "10bba67e-d846-4564-8d40-d31254ea2346",
      "batchId": "b9948a3a-e349-4f48-94e8-e92e99649d1d",
      "cameraId": 1,
      "cameraCode": "CAM-A-P01",
      "roundId": 1,
      "startTime": "2026-01-10T01:30:00.000Z",
      "endTime": "2026-01-10T01:34:00.000Z",
      "mediaCount": 4,
      "reviewStatus": "pending",
      "speciesName": null,
      "reviewNote": null
    }
  ]
}
```

### `GET /events/{eventId}`

สิทธิ์ `reviewer`, `researcher`, `admin` และ `road` โดย `road` อ่านเฉพาะเหตุการณ์ที่ยืนยันแล้วหรือสื่อที่ผูกกับเหตุการณ์ที่ยืนยันแล้ว

อ่านรายละเอียดเหตุการณ์หนึ่งรายการพร้อม `mediaId` ที่ใช้เปิดรูปหรือคลิปต่อ เหมาะสำหรับเรียกเมื่อผู้ใช้เปิดหน้ารายละเอียดเหตุการณ์

```js
const event = await apiFetch(`/events/${eventId}`);
```

นอกจากข้อมูลเหตุการณ์แบบเดียวกับรายการด้านบน จะมี `media` เพิ่มมา:

```json
{
  "id": "10bba67e-d846-4564-8d40-d31254ea2346",
  "reviewStatus": "pending",
  "media": [
    {
      "id": "e38d76b3-fb70-472d-91ef-caf79cf64c2b",
      "fileName": "camera-001.jpg",
      "capturedAt": "2026-01-10T01:30:00.000Z"
    }
  ]
}
```

### `PATCH /events/{eventId}`

สิทธิ์ `reviewer`, `researcher` และ `admin`

บันทึกผลตรวจลง `AppEventReviews` ด้วย `Outcome` และ `ReviewerUserId` ค่า `reviewStatus` ที่รองรับคือ `pending`, `confirmed`, `rejected` ซึ่งแปลงเป็น `uncertain`, `wildlife` และ `no_wildlife` ตามลำดับ

```js
const event = await apiFetch(`/events/${eventId}`, {
  method: "PATCH",
  body: JSON.stringify({
    reviewStatus: "confirmed",
    speciesName: "ช้างป่า",
    behavior: "เดินผ่านทางลอด",
    reviewNote: "พบ 2 ตัว",
  }),
});
```

`speciesName`, `behavior` และ `reviewNote` ส่งเป็น `null` ได้ เมื่อไม่ส่ง `behavior` ระบบจะเก็บพฤติกรรมที่เคยบันทึกไว้

## 9. Media API

### `GET /media/{mediaId}`

สิทธิ์ `reviewer`, `researcher`, `admin` และ `road` โดย `road` อ่านเฉพาะเหตุการณ์ที่ยืนยันแล้วหรือสื่อที่ผูกกับเหตุการณ์ที่ยืนยันแล้ว

สร้าง URL ชั่วคราวสำหรับอ่านไฟล์จาก Private Blob URL มีอายุประมาณ 5 นาที

Response:

```json
{
  "url": "https://...<temporary-sas>",
  "contentType": "image/jpeg",
  "expiresAt": "2026-11-10T06:45:00.000Z"
}
```

```js
const media = await apiFetch(`/media/${mediaId}`);
imageElement.src = media.url;
```

Frontend ไม่ควรบันทึก SAS URL ระยะยาว หาก URL หมดอายุให้เรียก endpoint นี้ใหม่ และไม่ควรแสดง URL ใน log

## 10. Report API

### `GET /reports/summary`

สิทธิ์ `reviewer`, `researcher`, `admin` และ `road` โดย `road` อ่านเฉพาะเหตุการณ์ที่ยืนยันแล้วหรือสื่อที่ผูกกับเหตุการณ์ที่ยืนยันแล้ว

สรุปจำนวนเหตุการณ์ ผลตรวจ และชนิดสัตว์ แยกตามรอบสำรวจและกล้อง

ใช้ได้ทั้ง:

```text
GET /reports/summary
GET /reports/summary?roundId=1
```

Response:

```json
{
  "rows": [
    {
      "roundId": 1,
      "roundName": "รอบสำรวจที่ 1 ประจำมกราคม 2026",
      "cameraId": 1,
      "cameraCode": "CAM-A-P01",
      "eventCount": 12,
      "confirmedCount": 7,
      "pendingCount": 4,
      "speciesCount": 3
    }
  ]
}
```

## 11. HTTP Status ที่ Frontend ต้องรองรับ

| Status | ความหมาย/วิธีจัดการ |
| --- | --- |
| `200` | สำเร็จ |
| `202` | รับ upload และส่งเข้า Queue แล้ว |
| `204` | สำเร็จแต่ไม่มี response body เช่น logout |
| `400` | input ไม่ถูกต้อง แสดงข้อความจาก `error` |
| `401` | ไม่ได้ login/session หมดอายุ ให้กลับหน้า login |
| `403` | role หรือ assignment ไม่มีสิทธิ์ |
| `404` | ไม่พบ batch/event/media |
| `409` | ใช้ `batchId` ซ้ำกับ upload คนละชุด ให้สร้าง UUID ใหม่ |
| `413` | ไฟล์รวมเกิน 25 MiB |
| `415` | ไม่ได้ส่ง upload แบบ multipart/form-data |
| `500` | Backend/SQL/Blob มีปัญหา แสดงข้อความทั่วไปและให้ลองใหม่ |

Error response ใช้รูปแบบเดียวกัน:

```json
{
  "error": "ข้อความอธิบายข้อผิดพลาด"
}
```

## 12. ลำดับการทำงานที่แนะนำ

### ทีมภาคสนาม

1. `POST /auth/login`
2. `GET /auth/me` เพื่อ restore session เมื่อ reload
3. `GET /catalog/cameras` และ `GET /catalog/rounds`
4. เลือกกล้อง/รอบ แล้ว `POST /uploadApi`
5. Poll `GET /batches/{batchId}` จนเสร็จ
6. `POST /auth/logout`

### ผู้ตรวจสอบ/นักวิจัย

1. Login และอ่าน `user.role`
2. `GET /events` พร้อม filter
3. `GET /events/{eventId}` เพื่ออ่านรายการ `mediaId`
4. เรียก `GET /media/{mediaId}` เมื่อต้องเปิดไฟล์
5. นักวิจัย ผู้ตรวจสอบ หรือผู้ดูแลระบบบันทึกผลด้วย `PATCH /events/{eventId}`
6. ดูสรุปด้วย `GET /reports/summary`

## 13. บัญชีสำหรับทดสอบเท่านั้น

| Username | Password | Role |
| --- | --- | --- |
| `field.demo` | `FieldDemo304!` | `field_team` |
| `review.demo` | `ReviewDemo304!` | `reviewer` |
| `research.demo` | `ResearchDemo304!` | `researcher` |
| `admin.demo` | `AdminDemo304!` | `admin` |

บัญชีเหล่านี้มีไว้สำหรับ demo/test เท่านั้น ควรเปลี่ยนรหัสผ่านหรือปิดใช้งานก่อนเปิด Production จริง
