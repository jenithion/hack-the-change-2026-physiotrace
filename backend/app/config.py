from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    # Temporary compatibility settings for legacy API routes; remove after their SQL port.
    supabase_url: str = Field("", validation_alias="NEXT_PUBLIC_SUPABASE_URL")
    supabase_publishable_key: str = Field("", validation_alias="NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    supabase_secret_key: str = Field("", validation_alias="SUPABASE_SECRET_KEY")

    # Auth0 identity provider
    auth0_domain: str = Field("", validation_alias="AUTH0_DOMAIN")
    auth0_audience: str = Field("", validation_alias="AUTH0_AUDIENCE")
    auth0_issuer: str = Field("", validation_alias="AUTH0_ISSUER")

    # TigerData PostgreSQL
    database_url: str = Field("", validation_alias="DATABASE_URL")
    database_ssl: bool = Field(True, validation_alias="DATABASE_SSL")
    db_pool_min: int = Field(1, validation_alias="DB_POOL_MIN")
    db_pool_max: int = Field(10, validation_alias="DB_POOL_MAX")

    cors_origins: str = Field("http://localhost:3000", validation_alias="CORS_ORIGINS")
    llm_base_url: str = Field("", validation_alias="LLM_BASE_URL")
    llm_api_key: str = Field("", validation_alias="LLM_API_KEY")
    llm_model: str = Field("", validation_alias="LLM_MODEL")
    llm_max_tokens: int = Field(512, validation_alias="LLM_MAX_TOKENS")
    admin_emails: str = Field("", validation_alias="ADMIN_EMAILS")

settings = Settings()
