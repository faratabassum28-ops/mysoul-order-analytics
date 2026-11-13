# Zoom demo: run in 5 minutes

Needs: Node 18+ and MongoDB running on this computer (no Shopify, Shipway or Google Sheet needed).

1. Start MongoDB:      docker run -d --name mongo -p 27017:27017 mongo:7      (or start your local mongod)
2. Install:            npm run install:all
3. Build the screens:  npm run build
4. Start the demo:     npm run demo
5. Open:               http://localhost:4000/team

Logins: admin / admin12345 · pack1 / pack12345 · confirm1 / confirm12345
Run `npm run demo` again any time to reset the test orders.
The demo uses its own database (mysoul_demo) and a pretend Shipway: nothing real is touched.
