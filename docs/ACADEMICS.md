# School structure: sessions, classes, admission numbers and student history

Everything here is per school and backwards compatible. A school that has not set anything up keeps the old
behaviour: the session comes from the date (April start), and any class or section is accepted.

## Academic sessions

- `AcademicSession`: `name` ("2026-27"), `startDate`, `endDate`, `status` (`upcoming`, `current`, `closed`).
  The database allows only one current session per school.
- The first session a school creates becomes current. Making another session current closes the previous one.
- Dates default from the school's session start month (`School.academic.sessionStartMonth`, default 4 = April).
- New admissions, report cards and the school profile use the current session. Fees and exams use the session
  their date falls in.
- With no sessions, the name comes from the date and the start month (`utils/dates.currentAcademicYear`).

## Class list (class master)

- `SchoolClass`: `name` ("10", "LKG"), `displayName`, `order`, `sections` (`name`, `classTeacher`, `capacity`),
  `subjects`, `isActive`.
- Once a school has at least one active class, students (create, edit, admit, promote) and teacher class
  assignments must use a class and section from the list. The error tells the admin to add it first.
- Classes are ordered Playgroup, Nursery, LKG, UKG, 1 to 12, then anything else.
- A class teacher must be a teacher of the school and is given the class in `assignedClasses` automatically.
- Safeguards: a section with active students cannot be removed; a class with students cannot be renamed or
  deactivated; a class that ever had students cannot be deleted.
- `POST /api/academic/classes/import` builds the list from the classes and sections students are already in.
- The `/api/students/classes` and `/api/students/sections` dropdowns use the list once it exists.

## Admission and roll numbers

- `Student.admissionNo`: unique within the school, shown on certificates and planned for student sign-in.
  When not given it is assigned as `<prefix><next number>` (prefix from `School.academic.admissionNoPrefix`,
  numbers from the per-school counter). A number entered by hand is kept and checked for duplicates.
- Roll numbers are optional: when empty, the next number in the class-section is used.
- Student search matches the name or the exact admission number.

## Enrollment history

- `StudentEnrollment`: one row per student per session with class, section, roll number and status
  (`studying`, `promoted`, `detained`, `left`, `graduated`).
- Created with the student; a class, section or roll correction in the same session updates it.
- Promotion into another session (`POST /api/bulk/promote { ..., toSession: "2027-28" }`) marks last year's row
  `promoted` and opens a new one. The session must exist.
- Removing a student marks the open row `left`, with the optional `reason`.
- `GET /api/students/:id/history` lists every session.

## API (`/api/academic`)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/sessions` | everyone in the school | Sessions and the current session name |
| POST | `/sessions` | admin | `{ name, startDate?, endDate?, makeCurrent? }` |
| PATCH | `/sessions/:id/current` | admin | Make a session current (closes the previous one) |
| GET | `/classes` | everyone in the school | Classes with sections, class teacher names, subjects and student counts |
| POST | `/classes` | admin | `{ name, displayName?, order?, sections: ["A"] or [{ name, classTeacher, capacity }], subjects }` |
| PUT | `/classes/:id` | admin | Same fields plus `isActive` |
| DELETE | `/classes/:id` | admin | Only if no student was ever in the class |
| POST | `/classes/import` | admin | Build the list from existing students |
| GET / PUT | `/settings` | read: everyone, write: admin | `{ sessionStartMonth, admissionNoPrefix }` |
| GET | `/setup-status` | admin | Onboarding checklist: session, classes, subjects, teachers, class teachers, students, timetable, fees |

Admin permission: `academics.manage`.

## Migration

`npm run migrate -- --apply` gives every student without an admission number one in joining order (the
counter continues after them) and creates a current-session enrollment for every active student.

## End of the academic year

1. Create the next session (School Setup).
2. `GET /api/academic/year-end?toSession=2027-28` lists every active student with a suggestion: the next class in
   the class order (same section if it exists there, else the first section); students of the last class pass out.
3. `POST /api/academic/year-end { toSession, decisions: [{ studentId, action, toClass?, toSection?, reason? }], makeCurrent? }`
   - `promote` (to `toClass`/`toSection`), `detain` (same class), `leave` (with a reason), `graduate` (pass out)
   - students without a decision get the suggestion
   - every decision is checked first; one invalid decision changes nothing
   - last year's enrollment is closed as promoted, detained, left or graduated; a new one is opened
   - roll numbers are given again, alphabetically, in every class-section that received students
   - students already in the new session are skipped, so a second run promotes nobody twice
   - `makeCurrent: true` also makes the new session current
4. Leaving or passing out deactivates the student's login, and the parent's when no other child is in the school.

Removing a student (`DELETE /api/students/:id { reason }`) is the same as `leave`.

## Transfer certificate

`GET /api/students/:id/transfer-certificate` (admins) for a student who has left or passed out: school, student
(admission number, date of birth, parent, admitted on, last class, left on, reason) and class history per session.
The number (`TC/<year>/0001`, per school) is given the first time and never changes.

Roll numbers are unique among students who are still in the school, so a number freed by a student who left can
be given to a new admission. (The migration replaces the old index that also counted students who had left.)
