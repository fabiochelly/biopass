import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signing = Properties().apply {
    val f = rootProject.file("signing/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.biopass"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.biopass"
        minSdk = 28
        targetSdk = 35
        versionCode = 10
        versionName = "1.3.6"
        // FLAG_SECURE (captures d'écran bloquées). « -PnoSecure » : uniquement pour les captures de test.
        resValue("bool", "bp_secure", if (project.hasProperty("noSecure")) "false" else "true")
    }

    signingConfigs {
        create("release") {
            if (signing.isNotEmpty()) {
                storeFile = rootProject.file("signing/" + signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = false
    }
    lint {
        checkReleaseBuilds = false
    }
    packaging {
        resources.excludes += setOf("META-INF/**", "kotlin/**", "DebugProbesKt.bin")
    }
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    // Seule dépendance : InlineSuggestionUi (suggestions dans la barre du clavier, Android 11+).
    implementation("androidx.autofill:autofill:1.1.0")
    testImplementation("junit:junit:4.13.2")
    // org.json est fourni par Android ; sur la JVM de test il faut une vraie implémentation.
    testImplementation("org.json:json:20240303")
}

tasks.withType<Test>().configureEach {
    environment("BIOPASS_IT_SERVER", System.getenv("BIOPASS_IT_SERVER") ?: "")
    environment("BIOPASS_IT_INFO", System.getenv("BIOPASS_IT_INFO") ?: "")
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
