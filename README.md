# CareerPath

## Supervision Note

**This project was developed for the Data Structures and Algorithms (DSA) course under the supervision of Lab Engineer Obaidullah Miakhil.**

## Group Details
**Group Members:**
- Name: Muhammad Ismail----Registration ID: B24F0628CS165
- Name: Saffi Ur Rehman----Registration ID: B24F0525CS167
- Name: Mahnoor Malik  ----Registration ID: B24F0282CS165


## Project Title & Description

**CareerPath** is a job matching platform that intelligently connects job seekers with opportunities based on their skills. The app features:

**CareerPath** is a simple job matching app with:
- Node/Express backend + MySQL
- Employer job posting & deletion
- Job seeker match scoring from entered skills
- Account dashboard with skill editing & best match
- Admin dashboard (stats, users, all jobs management)

## Features
- JWT cookie auth (`cp_token`) for sessions
- Skills persisted per user (comma-separated in DB)
- Role-based access control: `seeker`, `employer`, `admin`
- Admin user is pre-seeded on startup: `admin@gmail.com` / `123456`

## Visuals

### Demo Video
Watch the demo: [careerPath working.mp4](careerPath%20working.mp4)

<video src="careerPath%20working.mp4" controls width="800"></video>

### Screenshots
- Job seeker dashboard with skill matching
  ![Job seeker dashboard](Seeker%20dashboard.png)

- Employer job posting
  ![Employer job posting](job%20posting.png)

- Admin dashboard with statistics
  ![Admin dashboard](admin%20dashboard.png)

- 

## Local Setup

### Requirements
- Node.js 18+
- MySQL 8 (local or hosted)

### Environment variables
Create a `.env` file at the project root:
```
PORT=3000
JWT_SECRET=change_me
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=careerpath
NODE_ENV=development
```
Adjust for your MySQL setup.

### Install & run
```bash
npm install
node server.js
```
- API will run on `http://localhost:3000`
- For the static frontend, use VS Code Live Server (port 5500) or any static server.

### Admin login
Use the seeded admin credentials:
- Email: `admin@gmail.com`
- Password: `123456`

On login, admin-only routes and the Admin menu appear.

## Hosting

Recommended split hosting:

- Backend (API + auth + DB): Railway (Node service) + MySQL (Railway or PlanetScale)
- Frontend (static HTML): Vercel or Netlify

### Backend on Railway
1. Create a new Railway project.
2. Provision a MySQL database (Railway plugin) and copy credentials.
3. Connect your GitHub repo and deploy the Node service.
4. Set environment variables in Railway (match your `.env`).
5. Deploy; you’ll get an API URL like `https://career-path-production.up.railway.app`.

### Frontend on Vercel/Netlify
- Deploy the `jobseeker.html`, `employer.html`, `account.html`, `admin.html` as static site.
- In production, set the API base URL for the frontend. The pages auto-detect local dev and otherwise fall back; you can override by injecting:
  ```html
  <script>window.API_BASE = 'https://your-api.example.com';</script>
  ```
  Add this near the top of each HTML page if needed.

## API
- `POST /api/auth/register` (seeker/employer only)
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/user/skills` (save skills for the current user)
- `GET /api/jobs`, `GET /api/jobs/:id`
- Employer: `GET /api/my-jobs`, `POST /api/jobs`, `DELETE /api/jobs/:id`
- Admin: `GET /api/admin/stats`, `GET /api/admin/jobs`, `DELETE /api/admin/jobs/:id`, `GET /api/admin/users`

## Development Notes
- Migrations are handled inline on startup: user table columns + admin role enum update, job owner column, admin seeding.
- Match scoring is simple percentage of required skills present.


## License
MIT (see LICENSE).
