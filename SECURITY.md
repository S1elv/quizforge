# Security

Do not commit `.env`, database credentials, `SETUP_KEY`, `CRON_SECRET`, session secrets, or production exports.

For production:

- use HTTPS;
- set a long random `SETUP_KEY` and rotate/remove it after first setup;
- set a separate random `CRON_SECRET`;
- use Neon pooled `DATABASE_URL` for application traffic;
- restrict CORS to the deployed application origin;
- keep the database private to the application account where the provider supports it.

Technical attempt events are context signals. QuizForge does not automatically label a learner as cheating or violating rules.
