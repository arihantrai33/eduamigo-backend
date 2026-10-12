# Student photos: privacy design and migration

## How it works now
- A photo is uploaded with the student form. The server checks the **bytes** of the file (JPEG, PNG or WebP only; SVG, GIF, HEIC, scripts
  and text are refused whatever type the browser claims), limit 5 MB.
- It is stored in Cloudinary as an **authenticated** asset (no public address exists) at `eduamigo/<schoolId>/students/<random 32 hex>`,
  resized to at most 800 x 800. The key is saved in `Student.photoKey`.
- The API never returns the key or a Cloudinary address. Wherever a student appears, `photo` is a link to this server:
  `PUBLIC_API_URL/api/photos/<token>`. The token holds the asset key and an expiry, signed with a key derived from `JWT_SECRET`
  (default life 2-2.5 hours, `PHOTO_URL_TTL_SECONDS`). A changed, cut, expired or unknown token gets a plain 404.
- Only people who may already see the student receive a link (the same permissions as the student record). The link works without a
  login because an `<img>` tag cannot send one; this is why it expires. Links made in the same half hour are identical, so browsers cache the image
  (`Cache-Control: private`).
- A photo address typed into a form is ignored. A photo only comes from an uploaded file. If saving fails, the new file is deleted again;
  replacing a photo deletes the old private file.
- The image route has its own limit (600 per minute per address, `PHOTO_PER_MINUTE`).

## Limits to know
- Anyone holding a link can open the picture until it expires (up to about 2.5 hours). It cannot be extended or guessed.
- The picture is downloaded by the server and sent on, so photo traffic passes through the API.
- The upload is resized by Cloudinary; whether camera location data is removed from the stored original has **not** been verified.
- Teacher and parent photos (`Teacher.photo`, `Parent.photo`) are not covered yet; they have no upload route in this API.
- Existing photos stay on their old public address until they are migrated (below). Until stage B, the old file is still publicly reachable.

## Migrating existing photos (not run anywhere yet)
Run in staging first, on a copy of the data. Back up first (`npm run backup`).

1. `node src/scripts/migratePhotos.js` (dry run). Prints counts only: photos to copy, already private, and addresses that are not ours
   (`foreign_address`, left alone and reported).
2. `node src/scripts/migratePhotos.js --apply` (**stage A**). For each student it copies the public file to a private asset in the student's own school
   path and sets `photoKey`. The old file and `Student.photo` are untouched, so the app switches to private links at once and nothing is lost.
   It is safe to repeat; one failing photo does not stop the others and leaves no half copy.
3. Check in the app: photos show for admin, teacher, student and parent; open a link; open a link after waiting past its expiry (404).
4. **Rollback of stage A:** `db.students.updateMany({ photoKey: { $exists: true } }, { $unset: { photoKey: 1 } })`. The old public photos work again.
   (Delete the private copies under `eduamigo/<school>/students/` in Cloudinary if you want them gone.)
5. `node src/scripts/migratePhotos.js --finalize` (dry run), then `--finalize --apply` (**stage B**, **cannot be undone**). For each student it first confirms the private copy
   exists, then deletes the old public file and clears `Student.photo`. A student whose copy cannot be confirmed is skipped and reported.
   Only after this are the old public addresses dead.

## Tests
`tests/photos.test.js` (storage path, no key or cloud address in responses, form-typed addresses ignored, cleanup on failure, file-type checks,
link tampering and expiry, other schools, old addresses still shown, the migration stages and their undo). The security checks were each switched off
once to confirm a test fails without them.
