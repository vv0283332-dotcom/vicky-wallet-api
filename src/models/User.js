class User {
  constructor({
    id,
    name,
    email,
    password
  }) {
    this.id = id;
    this.name = name;
    this.email = email;
    this.password = password;
    this.createdAt = new Date().toISOString();
  }
}

export default User;
