import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyB5a5y791lUGWpr991sWHQko-rXlS7LGvs",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "truthlens-ai-57a2c.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "truthlens-ai-57a2c",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "truthlens-ai-57a2c.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "615579541019",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:615579541019:web:4011da06e8c5d0f086e2be",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-YNDK6P6RS0"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
